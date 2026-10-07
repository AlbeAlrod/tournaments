// Characterization tests for core/legacy.js = today's app.js behaviour.
// Every assertion records CURRENT output. Lines marked `KNOWN BUG:` assert today's
// wrong behaviour on purpose: when a bug is fixed in app.js + legacy.js, flip that test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../core/legacy.js';

const teams = n => Array.from({ length: n }, (_, i) => `T${i + 1}`);
const num = s => parseInt(String(s).replace(/\D/g, ''), 10);

function setup(cfg, n, extra = {}) {
  const ctx = {
    categories: [{ id: 'c', name: 'C', cfg }],
    state: { c: { roster: teams(n), groups: [], sched: [], ko: [] } },
    meta: {}, registrations: [], ...extra,
  };
  const api = L.createLegacy(ctx);
  return { ctx, api, cs: ctx.state.c };
}
// Lower team number always wins, with a score valid for the given target.
const winScore = (g, to) => (num(g.a) < num(g.b) ? [to, to - 5] : [to - 5, to]);
function playPools(api, cs, to = 15) {
  cs.sched.forEach(g => { if (g.gi >= 0) [g.sa, g.sb] = winScore(g, to).map(String); });
  api.updateKOForCat('c');
}

const QUEEN_CFG = { // admin.html createTournament() queen preset
  courts: 4, gameDur: 15, breakDur: 0, numGroups: 4, advPerGroup: 3,
  pointsToWin: 21, sets: 1, pointsThirdSet: 21, startTime: '17:00',
  seeding: 'snake', koFormat: 'queen',
  koRules: { pool: { pts: 15, change: 5 }, r16: { pts: 18, change: 6 }, qf: { pts: 18, change: 6 },
             sf: { pts: 18, change: 6 }, third: { pts: 15, change: 5 }, final: { pts: 21, change: 7 } },
};

// ------------------------------------------------------------------ helpers
describe('time helpers', () => {
  test('t2m / m2t / addM', () => {
    assert.equal(L.t2m('08:30'), 510);
    assert.equal(L.t2m(''), 0);
    assert.equal(L.m2t(510), '08:30');
    assert.equal(L.m2t(24 * 60 + 5), '00:05'); // wraps past midnight
    assert.equal(L.addM('23:50', 20), '00:10');
  });
});

describe('dn / normName', () => {
  test('dn strips the Hebrew "ו" connector only before a word', () => {
    assert.equal(L.dn('תום ומוריאל'), 'תום מוריאל');
    assert.equal(L.dn('A1'), 'A1');
    assert.equal(L.dn('Winner of X'), 'Winner of X');
    assert.equal(L.dn('דנה / ורד'), 'דנה / ורד');
  });
  test('normName treats "/" as a space and lowercases', () => {
    assert.equal(L.normName('Tom / Muriel'), 'tom muriel');
    assert.equal(L.normName('  Tom   Muriel '), 'tom muriel');
    assert.equal(L.normName(null), '');
  });
});

describe('Firestore KO (de)serialization', () => {
  test('koToFB / koFromFB round-trip with numeric key order', () => {
    const ko = Array.from({ length: 11 }, (_, i) => [{ i }]);
    const fb = L.koToFB(ko);
    assert.deepEqual(Object.keys(fb).slice(0, 3), ['r0', 'r1', 'r2']);
    assert.deepEqual(L.koFromFB(fb), ko);
    assert.deepEqual(L.koFromFB(null), []);
  });
  test('catStateToFB / catStateFromFB fill defaults', () => {
    assert.deepEqual(L.catStateToFB({}), { roster: [], groups: [], sched: [], ko: {} });
    assert.deepEqual(L.catStateFromFB({ ko: { r1: [2], r0: [1] } }),
      { roster: [], groups: [], sched: [], ko: [[1], [2]] });
  });
});

// ------------------------------------------------------------------ scoring
describe('isValidScore / scoreError (1 set, pointsToWin 21)', () => {
  const { api } = setup({ ...L.DEF_CAT_CFG }, 4);
  const v = (a, b, p) => api.isValidScore(a, b, 'c', p);
  const table = [
    [21, 19, true], [21, 0, true], [19, 21, true], [21, 20, false], [22, 21, false],
    [23, 21, true], [22, 20, true], [30, 28, true], [30, 27, false], [24, 21, false],
    [20, 18, false], [21, 21, false], [0, 0, false], [-1, 21, false], [NaN, 21, false],
  ];
  for (const [a, b, ok] of table) test(`${a}-${b} → ${ok}`, () => assert.equal(v(a, b), ok));

  test('ptwOverride replaces pointsToWin', () => {
    assert.equal(v(15, 13, 15), true);
    assert.equal(v(15, 14, 15), false);
    assert.equal(v(17, 15, 15), true);
    assert.equal(v(15, 13), false); // below 21
  });
  test('"" is invalid', () => assert.equal(v('', 3), false));

  test('scoreError messages', () => {
    const e = (a, b, p) => api.scoreError(a, b, 'c', p);
    assert.equal(e('', '5'), null);
    assert.equal(e('x', '5'), null);
    assert.equal(e('-1', '21'), 'Scores must be 0 or higher');
    assert.equal(e('21', '21'), "Scores can't be equal");
    assert.equal(e('20', '18'), 'Must reach 21 · e.g. 21–18');
    assert.equal(e('21', '20'), 'Need 2-point lead');
    assert.equal(e('22', '21'), 'Above 21: exactly 2 apart');
    assert.equal(e('25', '21'), 'Above 21: exactly 2 apart');
    assert.equal(e('23', '21'), null);
    assert.equal(e('15', '9', 15), null);
  });
  test('no cap: arbitrarily long deuce is valid', () => assert.equal(v(51, 49), true));
});

describe('isValidScore (sets: 3 → scores are SETS WON)', () => {
  const { api } = setup({ ...L.DEF_CAT_CFG, sets: 3 }, 4);
  const table = [[2, 1, true], [2, 0, true], [1, 2, true], [0, 2, true], [2, 2, false],
                 [1, 0, false], [3, 1, false], [21, 19, false]];
  for (const [a, b, ok] of table)
    test(`${a}:${b} → ${ok}`, () => assert.equal(api.isValidScore(a, b, 'c'), ok));
  test('scoreError', () => {
    assert.equal(api.scoreError('3', '1', 'c'), 'Sets won: 2:0 or 2:1');
    assert.equal(api.scoreError('1', '0', 'c'), 'Winner must have 2 sets');
    assert.equal(api.scoreError('2', '1', 'c'), null);
    // Quirk: 2:2 passes scoreError (null) but isValidScore rejects it.
    assert.equal(api.scoreError('2', '2', 'c'), null);
  });
});

describe('getRuleForGame', () => {
  test('per-stage defaults by distance from the final', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG }, 4);
    cs.ko = [[{}, {}, {}, {}, {}, {}, {}, {}], [{}, {}, {}, {}], [{}, {}], [{}]];
    assert.equal(api.getRuleForGame('c', { gi: 0 }, false).pts, 15);
    assert.equal(api.getRuleForGame('c', { gi: -1 }, false).pts, 15); // third
    assert.equal(api.getRuleForGame('c', { ri: 0 }, true).pts, 18);   // r16
    assert.equal(api.getRuleForGame('c', { ri: 1 }, true).pts, 18);   // qf
    assert.equal(api.getRuleForGame('c', { ri: 3 }, true).pts, 21);   // final
    assert.equal(api.getRuleForGame('c', {}, true).pts, 15 + 3);      // ri missing → ri 0
    assert.equal(api.getRuleForGame('c', { ri: 3 }, true).change, 7);
  });
  test('koRules override merges per stage', () => {
    const { api } = setup({ ...L.DEF_CAT_CFG, koRules: { pool: { pts: 11, change: 4 } } }, 4);
    assert.deepEqual(api.getRuleForGame('c', { gi: 0 }, false), { pts: 11, change: 4 });
  });
  test('KNOWN BUG: cfg.pointsToWin is ignored — the per-stage rule (pool=15) always wins', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG, pointsToWin: 21 }, 4);
    api.buildCategory('c');
    const g = cs.sched[0];
    [g.sa, g.sb] = ['15', '10']; // would be invalid to 21
    const st = api.getStandings('c', 0);
    assert.equal(st.reduce((s, t) => s + t.w, 0), 1, 'a 15-10 pool game is counted');
    [g.sa, g.sb] = ['21', '10']; // a "proper" game to 21 is rejected (above 15 must be 2 apart)
    assert.equal(api.getStandings('c', 0).reduce((s, t) => s + t.w, 0), 0);
  });
});

// ------------------------------------------------------------------ pairing & groups
describe('rr (round robin pairings)', () => {
  const expected = {
    3: [['T2','T3'],['T1','T3'],['T1','T2']],
    4: [['T1','T4'],['T2','T3'],['T1','T3'],['T4','T2'],['T1','T2'],['T3','T4']],
    5: [['T2','T5'],['T3','T4'],['T1','T5'],['T2','T3'],['T1','T4'],['T5','T3'],['T1','T3'],['T4','T2'],['T1','T2'],['T4','T5']],
    6: [['T1','T6'],['T2','T5'],['T3','T4'],['T1','T5'],['T6','T4'],['T2','T3'],['T1','T4'],['T5','T3'],['T6','T2'],['T1','T3'],['T4','T2'],['T5','T6'],['T1','T2'],['T3','T6'],['T4','T5']],
    7: [['T2','T7'],['T3','T6'],['T4','T5'],['T1','T7'],['T2','T5'],['T3','T4'],['T1','T6'],['T7','T5'],['T2','T3'],['T1','T5'],['T6','T4'],['T7','T3'],['T1','T4'],['T5','T3'],['T6','T2'],['T1','T3'],['T4','T2'],['T6','T7'],['T1','T2'],['T4','T7'],['T5','T6']],
    8: [['T1','T8'],['T2','T7'],['T3','T6'],['T4','T5'],['T1','T7'],['T8','T6'],['T2','T5'],['T3','T4'],['T1','T6'],['T7','T5'],['T8','T4'],['T2','T3'],['T1','T5'],['T6','T4'],['T7','T3'],['T8','T2'],['T1','T4'],['T5','T3'],['T6','T2'],['T7','T8'],['T1','T3'],['T4','T2'],['T5','T8'],['T6','T7'],['T1','T2'],['T3','T8'],['T4','T7'],['T5','T6']],
  };
  for (let n = 3; n <= 8; n++) test(`${n} teams`, () => {
    const g = L.rr(teams(n));
    assert.deepEqual(g, expected[n]);
    assert.equal(g.length, n * (n - 1) / 2);
    const keys = new Set(g.map(p => [...p].sort().join('|')));
    assert.equal(keys.size, g.length, 'every pair exactly once');
  });
  test('0/1 teams → no games', () => { assert.deepEqual(L.rr([]), []); assert.deepEqual(L.rr(['x']), []); });
  test('KNOWN BUG: a team literally named "BYE" is treated as the bye sentinel', () => {
    assert.equal(L.rr(['A', 'B', 'BYE']).length, 1);
  });
});

describe('distributeGroups / snakeDistribute', () => {
  test('distributeGroups: extras go to the first groups', () => {
    assert.deepEqual(L.distributeGroups(10, 2), [5, 5]);
    assert.deepEqual(L.distributeGroups(11, 3), [4, 4, 3]);
    assert.deepEqual(L.distributeGroups(2, 4), [1, 1, 0, 0]);
  });
  test('snakeDistribute 16 into 4', () => {
    const g = L.snakeDistribute(teams(16), 4);
    assert.deepEqual(g.map(x => x.name), ['A', 'B', 'C', 'D']);
    assert.deepEqual(g.map(x => x.teams), [
      ['T1', 'T8', 'T9', 'T16'], ['T2', 'T7', 'T10', 'T15'],
      ['T3', 'T6', 'T11', 'T14'], ['T4', 'T5', 'T12', 'T13']]);
  });
  test('snakeDistribute 7 into 3 and 1 group', () => {
    assert.deepEqual(L.snakeDistribute(teams(7), 3).map(x => x.teams),
      [['T1', 'T6', 'T7'], ['T2', 'T5'], ['T3', 'T4']]);
    assert.deepEqual(L.snakeDistribute(teams(3), 1)[0].teams, ['T1', 'T2', 'T3']);
  });
  test('cmpScore / roundName', () => {
    assert.ok(L.cmpScore([1, 2, 3], [1, 2, 2]) > 0);
    assert.equal(L.cmpScore([1, 2], [1, 2]), 0);
    assert.equal(L.roundName(8), 'Quarterfinals');
    assert.equal(L.roundName(6), 'Round of 6');
  });
});

// ------------------------------------------------------------------ standings
describe('getStandings', () => {
  function grp(results) {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG }, 0);
    cs.groups = [{ name: 'A', teams: ['W', 'X', 'Y', 'Z'] }];
    cs.sched = results.map(([a, b, sa, sb]) => ({ gi: 0, a, b, sa: String(sa), sb: String(sb) }));
    return api.getStandings('c', 0);
  }
  test('win = 2 pts, loss = 1 pt, records scored/against/diff', () => {
    const st = grp([['W', 'X', 15, 10]]);
    assert.deepEqual(st[0], { name: 'W', w: 1, l: 0, pts: 2, scored: 15, against: 10, diff: 5 });
    assert.deepEqual(st[1], { name: 'X', w: 0, l: 1, pts: 1, scored: 10, against: 15, diff: -5 });
  });
  test('tiebreak: pts, then wins, then diff, then points scored, then roster order', () => {
    // 3-way tie on 2 wins each; diff decides
    const st = grp([
      ['W', 'X', 15, 13], ['X', 'Y', 15, 5], ['Y', 'W', 15, 13],
      ['W', 'Z', 15, 0], ['X', 'Z', 15, 0], ['Y', 'Z', 15, 0]]);
    assert.deepEqual(st.map(t => t.name), ['X', 'W', 'Y', 'Z']);
    assert.deepEqual(st.map(t => t.pts), [5, 5, 5, 3]);
    assert.deepEqual(st.map(t => t.diff), [23, 15, 7, -45]);
  });
  test('tiebreak: equal pts/wins/diff → more points scored first', () => {
    // W and X both 1-1 with diff 0; X scored more.
    const st = grp([['W', 'Y', 15, 10], ['Z', 'W', 15, 10], ['X', 'Y', 17, 15], ['Z', 'X', 17, 15]]);
    const wx = st.filter(t => t.name === 'W' || t.name === 'X');
    assert.deepEqual(wx.map(t => [t.name, t.pts, t.diff, t.scored]), [['X', 3, 0, 32], ['W', 3, 0, 25]]);
  });
  test('no head-to-head: equal teams keep roster order even if the lower one won the meeting', () => {
    const st = grp([['X', 'W', 15, 10], ['W', 'Y', 15, 10], ['Y', 'X', 15, 10]]);
    assert.deepEqual(st.slice(0, 3).map(t => t.name), ['W', 'X', 'Y']);
  });
  test('mid-pool quirk: two losses (2 pts) tie with one win (2 pts) until wins break it', () => {
    const st = grp([['W', 'X', 15, 10], ['Y', 'X', 15, 10]]);
    assert.deepEqual(st.map(t => [t.name, t.pts]), [['W', 2], ['Y', 2], ['X', 2], ['Z', 0]]);
  });
  test('invalid scores are ignored; names match through normName', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG }, 0);
    cs.groups = [{ name: 'A', teams: ['Tom / Muriel', 'Ann / Bo'] }];
    cs.sched = [{ gi: 0, a: 'tom muriel', b: 'Ann  /  Bo', sa: '15', sb: '12' },
                { gi: 0, a: 'Tom / Muriel', b: 'Ann / Bo', sa: '15', sb: '14' }];
    const st = api.getStandings('c', 0);
    assert.deepEqual(st.map(t => [t.name, t.w, t.l]), [['Tom / Muriel', 1, 0], ['Ann / Bo', 0, 1]]);
  });
});

// ------------------------------------------------------------------ schedules
const fmt = g => `${g.si}/${g.court}@${g.time} ${g.a}-${g.b}`;

describe('generateScheduleForCat: 10 pairs, 2 groups, 2 courts (defaults)', () => {
  const { api, cs } = setup({ ...L.DEF_CAT_CFG }, 10);
  api.buildCategory('c');
  test('groups by contiguous blocks', () => {
    assert.deepEqual(cs.groups.map(g => g.teams), [teams(10).slice(0, 5), teams(10).slice(5)]);
  });
  test('pool schedule (20 games, 10 slots of 30 min, group A on court 1)', () => {
    assert.equal(cs.sched.length, 20);
    assert.deepEqual(cs.sched.slice(0, 6).map(fmt), [
      '0/1@08:00 T2-T5', '0/2@08:00 T7-T10', '1/1@08:30 T3-T4',
      '1/2@08:30 T8-T9', '2/1@09:00 T1-T5', '2/2@09:00 T6-T10']);
    assert.ok(cs.sched.every(g => g.court === (g.gi === 0 ? 1 : 2)));
    assert.equal(cs.sched.at(-1).time, '12:30');
  });
  test('no pair plays twice in a slot', () => {
    const bySlot = {};
    cs.sched.forEach(g => (bySlot[g.si] ||= []).push(g.a, g.b));
    Object.values(bySlot).forEach(ts => assert.equal(new Set(ts).size, ts.length));
  });
  test('KO: SF A1-B2, B1-A2 then final; times are cumulative per stage dur', () => {
    assert.deepEqual(cs.ko.map(r => r.map(fmt)), [
      ['10/1@13:00 A1-B2', '10/2@13:00 B1-A2'],
      ['11/1@13:30 Winner of Final 1-Winner of Final 2']]);
  });
  test('KNOWN BUG: at build time later rounds are labelled "Winner of Final N" (fixed on first updateKOForCat)', () => {
    assert.equal(cs.ko[1][0].a, 'Winner of Final 1');
    api.updateKOForCat('c');
    assert.equal(cs.ko[1][0].a, 'A1/B2');
  });
  test('KO resolution after pool + KO scores', () => {
    playPools(api, cs, 15);
    assert.deepEqual(cs.ko[0].map(g => [g.a, g.b]), [['T1', 'T7'], ['T6', 'T2']]);
    // SF rule = 18 (fromEnd 1)
    cs.ko[0][0].sa = '15'; cs.ko[0][0].sb = '10'; api.updateKOForCat('c');
    assert.equal(cs.ko[1][0].a, 'A1/B2', 'a 15-pt SF result is not valid under the 18 rule');
    cs.ko[0][0].sa = '18'; cs.ko[0][0].sb = '16';
    cs.ko[0][1].sa = '17'; cs.ko[0][1].sb = '19';
    api.updateKOForCat('c');
    assert.deepEqual([cs.ko[1][0].a, cs.ko[1][0].b], ['T1', 'T2']);
    assert.equal(api.getKOWinner(cs.ko[0][1], 'c'), 'T2');
    assert.equal(api.getKOLoser(cs.ko[0][1], 'c'), 'T6');
    cs.ko[1][0].sa = '21'; cs.ko[1][0].sb = '23';
    assert.equal(api.getKOWinner(cs.ko[1][0], 'c'), 'T2');
    assert.equal(cs.sched.some(g => g.isThirdPlace), false, 'standard KO has no 3rd-place game');
  });
  test('resolvePoolSeed only once the whole group is played', () => {
    const t = setup({ ...L.DEF_CAT_CFG }, 10); t.api.buildCategory('c');
    assert.deepEqual(t.api.resolvePoolSeed('c', 'A1'), { label: 'A1', known: false });
    playPools(t.api, t.cs);
    assert.deepEqual(t.api.resolvePoolSeed('c', 'A1'), { label: 'T1', known: true });
    assert.deepEqual(t.api.resolvePoolSeed('c', 'A9'), { label: 'A9', known: false });
    assert.deepEqual(t.api.resolvePoolSeed('c', 'Z1'), { label: 'Z1', known: false });
    assert.deepEqual(t.api.resolvePoolSeed('c', ''), { label: 'TBD', known: false });
  });
});

describe('generateScheduleForCat: 16 pairs, 4 groups, 4 courts, adv 2', () => {
  const { api, cs } = setup({ ...L.DEF_CAT_CFG, courts: 4, numGroups: 4, advPerGroup: 2 }, 16);
  api.buildCategory('c');
  test('shape: 24 pool games in 6 slots, QF/SF/F', () => {
    assert.equal(cs.sched.length, 24);
    assert.equal(Math.max(...cs.sched.map(g => g.si)), 5);
    assert.deepEqual(cs.ko.map(r => r.length), [4, 2, 1]);
    assert.deepEqual(cs.ko[0].map(g => `${g.a}-${g.b}`), ['A1-D2', 'B1-C2', 'C1-B2', 'D1-A2']);
    assert.deepEqual(cs.ko.map(r => r[0].time), ['11:00', '11:30', '12:00']);
  });
  test('QF→SF uses cross pairing (QF1×QF4, QF2×QF3)', () => {
    playPools(api, cs);
    cs.ko[0].forEach(g => { [g.sa, g.sb] = winScore(g, 18).map(String); });
    api.updateKOForCat('c');
    // QF: T1-T14, T5-T10, T9-T6, T13-T2 → winners T1, T5, T6, T2 (lower number wins)
    assert.deepEqual(cs.ko[1].map(g => [g.a, g.b]), [['T1', 'T2'], ['T5', 'T6']]);
    assert.equal(api.koGameLabel('c', 0, 2), 'QF3');
    assert.equal(api.koGameLabel('c', 1, 1), 'SF2');
    assert.equal(api.koGameLabel('c', 2, 0), 'Final');
    assert.equal(api.getKORoundName('c', 0), 'Quarterfinals');
  });
});

describe('KNOWN BUGS in the standard bracket', () => {
  test('KNOWN BUG: non-power-of-2 qualifiers (3 groups × 2) leave "TBD" opponents that never resolve', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG, numGroups: 3, advPerGroup: 2 }, 12);
    api.buildCategory('c');
    assert.deepEqual(cs.ko[0].map(g => `${g.a}-${g.b}`), ['A1-TBD', 'B1-TBD', 'C1-C2', 'A2-B2']);
    playPools(api, cs);
    assert.equal(cs.ko[0][0].b, 'TBD');
    // A1 should get a bye, but nothing ever advances it:
    assert.equal(api.getKOWinner(cs.ko[0][0], 'c'), null);
    assert.equal(cs.ko[1][0].a, 'A1/TBD');
    // Also: two teams from the same group (C1, C2) meet in the first KO round.
    assert.deepEqual([cs.ko[0][2].a, cs.ko[0][2].b], ['T9', 'T10']);
  });
  test('KNOWN BUG: with 16 qualifiers, seeds 1 and 2 (A1, B1) meet already in the QF', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG, courts: 4, numGroups: 4, advPerGroup: 4 }, 16);
    api.buildCategory('c');
    assert.deepEqual(cs.ko.map(r => r.length), [8, 4, 2, 1]);
    assert.deepEqual(cs.ko[0].slice(0, 2).map(g => `${g.a}-${g.b}`), ['A1-D4', 'B1-C4']);
    api.updateKOForCat('c');
    assert.deepEqual([cs.ko[1][0].a, cs.ko[1][0].b], ['A1/D4', 'B1/C4']);
  });
  test('adv < 1 → no KO', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG, advPerGroup: 0 }, 6);
    api.buildCategory('c');
    assert.deepEqual(cs.ko, []);
  });
});

describe('QUEEN preset (admin.html createTournament)', () => {
  const { api, cs } = setup(QUEEN_CFG, 16);
  api.buildCategory('c');
  test('snake groups, 24 pool games 17:00–18:15 on 4 courts', () => {
    assert.deepEqual(cs.groups[0].teams, ['T1', 'T8', 'T9', 'T16']);
    assert.equal(cs.sched.filter(g => g.gi >= 0).length, 24);
    assert.equal(cs.sched[0].time, '17:00');
    assert.equal(cs.sched.filter(g => g.gi >= 0).at(-1).time, '18:15');
  });
  test('KO structure: R16 with byes, QF, SF, Final + parallel 3rd place', () => {
    assert.deepEqual(cs.ko.map(r => r.length), [8, 4, 2, 1]);
    assert.deepEqual(cs.ko[0].map(g => g.isBye ? `bye ${g.a}` : `${g.a}-${g.b}`),
      ['bye A1', 'B2-A3', 'bye B1', 'A2-B3', 'bye C1', 'D2-C3', 'bye D1', 'C2-D3']);
    assert.deepEqual(cs.ko.map(r => r.filter(g => !g.isBye).map(g => g.time)),
      [['18:30', '18:30', '18:30', '18:30'], ['18:45', '18:45', '18:45', '18:45'], ['19:00', '19:00'], ['19:15']]);
    const third = cs.sched.find(g => g.isThirdPlace);
    assert.deepEqual([third.court, third.si, third.time], [2, cs.ko[3][0].si, '19:15']);
    assert.equal(cs.ko[0][0].si, undefined, 'byes are not scheduled');
  });
  test('resolution: byes advance, SF crosses, 3rd place gets SF losers', () => {
    playPools(api, cs, 15);
    // Group A = T1,T8,T9,T16 → A1=T1, A2=T8, A3=T9; B: T2,T7,T10 ...
    assert.deepEqual(cs.ko[1].map(g => g.a), ['T1', 'T2', 'T3', 'T4']);
    assert.deepEqual(cs.ko[1].map(g => g.b), ['B2/A3', 'A2/B3', 'D2/C3', 'C2/D3']);
    cs.ko[0].forEach(g => { if (!g.isBye) [g.sa, g.sb] = winScore(g, 18).map(String); });
    api.updateKOForCat('c');
    assert.deepEqual(cs.ko[1].map(g => g.b), ['T7', 'T8', 'T5', 'T6']);
    cs.ko[1].forEach(g => { [g.sa, g.sb] = winScore(g, 18).map(String); });
    api.updateKOForCat('c');
    assert.deepEqual(cs.ko[2].map(g => [g.a, g.b]), [['T1', 'T4'], ['T2', 'T3']]);
    cs.ko[2].forEach(g => { [g.sa, g.sb] = winScore(g, 18).map(String); });
    api.updateKOForCat('c');
    assert.deepEqual([cs.ko[3][0].a, cs.ko[3][0].b], ['T1', 'T2']);
    const third = cs.sched.find(g => g.isThirdPlace);
    assert.deepEqual([third.a, third.b], ['T4', 'T3']);
    assert.equal(api.koGameLabel('c', 0, 0), '');
    assert.equal(api.koGameLabel('c', 0, 3), 'R16-2');
  });
  test('queen falls back to the standard bracket when groups !== 4', () => {
    const t = setup({ ...QUEEN_CFG, numGroups: 2 }, 8);
    t.api.buildCategory('c');
    assert.equal(t.cs.ko[0].some(g => g.isBye), false);
  });
});

describe('assignSlotTimes with per-stage dur', () => {
  test('slot length follows koRules[stage].dur', () => {
    const { api, cs } = setup({ ...L.DEF_CAT_CFG, gameDur: 15,
      koRules: { qf: { pts: 18, change: 5, dur: 20 }, final: { pts: 21, change: 7, dur: 25 } },
      courts: 4, numGroups: 4, advPerGroup: 2 }, 16);
    api.buildCategory('c');
    assert.equal(cs.sched.at(-1).time, '09:15');
    assert.deepEqual(cs.ko.map(r => r[0].time), ['09:30', '09:50', '10:05']);
  });
});

// ------------------------------------------------------------------ coordinated
describe('coordinated multi-category scheduler', () => {
  function coord(cfgs, meta = {}) {
    const ctx = {
      categories: cfgs.map((cfg, i) => ({ id: `k${i}`, name: `K${i}`, cfg })),
      state: Object.fromEntries(cfgs.map((_, i) =>
        [`k${i}`, { roster: teams(8).map(t => `${t}k${i}`), groups: [], sched: [], ko: [] }])),
      meta: { coordinated: true, ...meta }, registrations: [],
    };
    const api = L.createLegacy(ctx);
    api.buildCoordinatedGroups(); api.generateCoordinatedSchedule();
    return { ctx, api };
  }
  const allGames = ctx => Object.values(ctx.state).flatMap(cs => [...cs.sched, ...cs.ko.flat()]);
  const base = { ...L.DEF_CAT_CFG, gameDur: 20, numGroups: 2, advPerGroup: 2 };

  test('no court/time collision; finale category plays last', () => {
    const { ctx } = coord([base, base]);
    const g = allGames(ctx);
    assert.equal(g.length, 2 * (12 + 3 + 1)); // pools + SF/SF/F + 3rd place per category
    const keys = g.map(x => `${x.si}/${x.court}`);
    assert.equal(new Set(keys).size, keys.length);
    const lastSi = Math.max(...g.map(x => x.si));
    const last = g.filter(x => x.si === lastSi);
    assert.deepEqual(last.map(x => x.catId), ['k1', 'k1']); // finale's final + 3rd place
    assert.equal(last.filter(x => x.isThirdPlace).length, 1);
    // start = meta.startTime || first category's cfg.startTime || '17:00'
    assert.equal(ctx.state.k0.sched[0].time, '08:00');
  });
  test('coordinated KO adds a 3rd-place game per category and resolves seeds', () => {
    const { ctx } = coord([base, base]);
    assert.equal(ctx.state.k0.sched.filter(g => g.isThirdPlace).length, 1);
    assert.deepEqual(ctx.state.k0.ko[0].map(g => `${g.a}-${g.b}`), ['A1-B2', 'B1-A2']);
  });
  test('KNOWN BUG: comment says "no pair plays >3 games in a row" but the rule allows at most 2', () => {
    const { ctx } = coord([{ ...base, courts: 4 }, { ...base, courts: 4 }]);
    let maxRun = 0;
    for (const cs of Object.values(ctx.state)) {
      const by = {};
      cs.sched.filter(g => g.gi >= 0).forEach(g => [g.a, g.b].forEach(t => (by[t] ||= []).push(g.si)));
      for (const sis of Object.values(by)) {
        sis.sort((a, b) => a - b); let run = 1;
        for (let i = 1; i < sis.length; i++) { run = sis[i] === sis[i - 1] + 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
      }
    }
    assert.ok(maxRun <= 2, `max consecutive rounds = ${maxRun}`);
  });
  test('KNOWN BUG: courts: 1 is forced up to 2 courts', () => {
    const { ctx, api } = coord([{ ...base, courts: 1 }]);
    assert.equal(api.coordCfg().COURTS, 2);
    assert.ok(allGames(ctx).some(g => g.court === 2));
  });
  test('breakBeforeKO writes meta.breaks at the pool→KO boundary and shifts later rounds', () => {
    const { ctx } = coord([base], { breakBeforeKO: 30 });
    assert.equal(ctx.meta.breaks.length, 1);
    const at = ctx.meta.breaks[0].atTime;
    const firstKO = ctx.state.k0.ko[0][0];
    assert.equal(L.t2m(firstKO.time), L.t2m(at) + 30);
  });
  test('buildCoordinatedGroups pulls approved registrations when roster is empty', () => {
    const ctx = { categories: [{ id: 'k', cfg: base }], state: { k: { roster: [], groups: [], sched: [], ko: [] } },
      meta: {}, registrations: [
        { status: 'approved', category: 'k', p1: 'a', p2: 'b' },
        { status: 'pending', category: 'k', p1: 'c', p2: 'd' },
        { status: 'approved', category: 'k', p1: 'e' }] };
    L.createLegacy(ctx).buildCoordinatedGroups();
    assert.deepEqual(ctx.state.k.roster, ['a / b', 'e']);
    assert.deepEqual(ctx.state.k.groups.map(g => g.teams), [['a / b'], ['e']]);
  });
});
