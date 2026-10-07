// core/standings.js — sport-agnostic group standings.
//
//   computeStandings(entries, matches, standingsCfg) → rows[]
//
// entries: array of ids (strings) or { id, name? } objects. Output keeps their input
//          order as the final fallback (stable), like legacy getStandings.
// matches: [{ a, b, result }] where result is the output of validateResult()
//          ({ ok, winner, sets, units }). Matches that are not ok, have no winner, or
//          reference an unknown entry on both sides are ignored. A match with one
//          unknown side still counts for the known side (legacy behaviour).
// standingsCfg: { points:{ win, draw, loss }, tiebreakers:[…] }
//   tiebreakers, applied in order (higher is better unless noted):
//     'points'    — table points
//     'wins'      — matches won
//     'h2h'       — mini-league among the still-tied entries only: table points,
//                   then unit difference, computed from their mutual matches; applied
//                   recursively to sub-groups that remain tied (like league.js breakTie)
//     'setRatio'  — sets won / sets lost (lost 0 → Infinity when won > 0)
//     'setDiff'   — sets won − sets lost
//     'unitDiff'  — points/games/goals for − against
//     'unitsFor'  — points/games/goals for
//     'unitRatio' — for / against (against 0 → Infinity when for > 0)
//
// Row: { id, name, played, wins, draws, losses, points, setsFor, setsAgainst,
//        unitsFor, unitsAgainst, unitDiff, rank, tied }
//   rank: 1-based position; entries that no tiebreaker separated share a rank and
//   get tied:true.

const toEntry = e => (typeof e === 'object' && e !== null ? { id: e.id, name: e.name ?? e.id } : { id: e, name: e });

function blankRow(e, i) {
  return { id: e.id, name: e.name, _i: i, played: 0, wins: 0, draws: 0, losses: 0, points: 0,
           setsFor: 0, setsAgainst: 0, unitsFor: 0, unitsAgainst: 0, unitDiff: 0 };
}

function counted(m) {
  const r = m && m.result;
  return !!(r && r.ok && r.winner);
}

function accumulate(rows, matches, pts) {
  for (const m of matches) {
    if (!counted(m)) continue;
    const r = m.result;
    const sides = [[rows[m.a], 'a', 'b'], [rows[m.b], 'b', 'a']];
    for (const [row, me, op] of sides) {
      if (!row) continue;
      row.played++;
      if (r.winner === 'draw') { row.draws++; row.points += pts.draw ?? 0; }
      else if (r.winner === me) { row.wins++; row.points += pts.win ?? 0; }
      else { row.losses++; row.points += pts.loss ?? 0; }
      if (r.sets) { row.setsFor += r.sets[me] || 0; row.setsAgainst += r.sets[op] || 0; }
      if (r.units) { row.unitsFor += r.units[me] || 0; row.unitsAgainst += r.units[op] || 0; }
    }
  }
  for (const row of Object.values(rows)) row.unitDiff = row.unitsFor - row.unitsAgainst;
  return rows;
}

const ratio = (f, a) => (a === 0 ? (f > 0 ? Infinity : 0) : f / a);

const METRIC = {
  points:    r => r.points,
  wins:      r => r.wins,
  setRatio:  r => ratio(r.setsFor, r.setsAgainst),
  setDiff:   r => r.setsFor - r.setsAgainst,
  unitDiff:  r => r.unitDiff,
  unitsFor:  r => r.unitsFor,
  unitRatio: r => ratio(r.unitsFor, r.unitsAgainst),
};

// Split an ordered group into consecutive blocks with equal key.
function blocksBy(group, key) {
  const sorted = [...group].sort((x, y) => key(y) - key(x) || x._i - y._i);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && key(last[0]) === key(r)) last.push(r);
    else out.push([r]);
  }
  return out;
}

// Mini-league between the members of `group` only. Returns blocks (recursively split).
function h2hBlocks(group, matches, pts) {
  if (group.length <= 1) return [group];
  const ids = new Set(group.map(r => r.id));
  const mini = {};
  group.forEach(r => { mini[r.id] = blankRow(r, r._i); });
  accumulate(mini, matches.filter(m => ids.has(m.a) && ids.has(m.b)), pts);
  const key = r => mini[r.id].points * 1e9 + mini[r.id].unitDiff; // points first, then diff
  const blocks = blocksBy(group, key);
  if (blocks.length === 1) return blocks;        // mini-league did not separate them
  return blocks.flatMap(b => h2hBlocks(b, matches, pts));
}

function rankGroup(group, tiebreakers, matches, pts) {
  if (group.length <= 1 || !tiebreakers.length) return [group];
  const [tb, ...rest] = tiebreakers;
  let blocks;
  if (tb === 'h2h') blocks = h2hBlocks(group, matches, pts);
  else {
    const f = METRIC[tb];
    if (!f) throw new Error(`computeStandings: unknown tiebreaker "${tb}"`);
    blocks = blocksBy(group, f);
  }
  return blocks.flatMap(b => rankGroup(b, rest, matches, pts));
}

export function computeStandings(entries, matches, standingsCfg = {}) {
  const pts = standingsCfg.points || { win: 2, draw: 0, loss: 1 };
  const tiebreakers = standingsCfg.tiebreakers || ['points'];
  const list = (entries || []).map(toEntry);
  const rows = {};
  list.forEach((e, i) => { rows[e.id] = blankRow(e, i); });
  const ms = (matches || []).filter(m => m && (rows[m.a] || rows[m.b]));
  accumulate(rows, ms, pts);

  const blocks = rankGroup(Object.values(rows).sort((x, y) => x._i - y._i), tiebreakers, ms, pts);
  const out = [];
  let pos = 1;
  for (const b of blocks) {
    const ordered = [...b].sort((x, y) => x._i - y._i);
    for (const r of ordered) {
      const { _i, ...row } = r;
      out.push({ ...row, rank: pos, tied: b.length > 1 });
    }
    pos += b.length;
  }
  return out;
}

// Convenience adapter: legacy sched games ({a,b,sa,sb}) → computeStandings matches,
// using validateResult with a given matchFormat. Kept here so callers do not need to
// know the result shape. `validate` is injected to avoid a hard import cycle.
export function matchesFromScores(games, matchFormatOf, validate) {
  return (games || []).map(g => ({ a: g.a, b: g.b, result: validate({ a: g.sa, b: g.sb, sets: g.sets }, matchFormatOf(g)) }));
}
