// core/scoring.js — sport-agnostic result validation.
//
//   validateResult(result, matchFormat) → { ok, error, winner, score, sets, units }
//
// matchFormat (see core/presets.js):
//   { type:'points', to, winBy=2, cap=null }                      single game/set
//   { type:'sets', bestOf, set:{to,winBy,cap,tiebreakAt}, decider?:{to,winBy,cap,tiebreakAt},
//     entry?:'detail'|'count' }                                    best-of-N sets
//   { type:'timed', minutes?, allowDraw=true }                     any score, draws allowed
//   { type:'free' }                                                no validation at all
//
// result:
//   points / timed / free / sets+entry:'count' → { a, b }   (numbers or numeric strings)
//   sets (entry:'detail', default)            → { sets:[[a,b], [a,b], …] }  (or {a,b} items)
//
// Output:
//   ok      true when the result is complete and legal
//   error   null | { key, params }  — i18n key, e.g. { key:'score.needLead', params:{ n:2 } }
//   winner  'a' | 'b' | 'draw' | null
//   score   headline score {a,b}: points (points/timed/free) or sets won (sets)
//   sets    sets won {a,b} (points/timed formats count as a 1-0 set for the winner)
//   units   total points/games/goals {a,b} (null when unknown, e.g. sets entered as a count)
//
// Error keys: score.empty, score.notInteger, score.negative, score.equal,
//   score.mustReach{n,lo}, score.needLead{n}, score.exactLead{to,n}, score.overCap{cap},
//   score.capRange{cap,min}, sets.countRange{need,maxLose}, sets.needWins{n},
//   sets.incomplete{need}, sets.afterDecided{set}. Errors inside a set carry params.set (1-based).

const err = (key, params = {}) => ({ key, params });
const fail = (key, params) => ({ ok: false, error: err(key, params), winner: null, score: null, sets: null, units: null });

// Parse one side. Returns { v } or { e:errorKey }.
function num(x) {
  if (x === '' || x === null || x === undefined) return { e: 'score.empty' };
  const v = typeof x === 'number' ? x : Number(String(x).trim());
  if (!Number.isFinite(v) || !Number.isInteger(v)) return { e: 'score.notInteger' };
  if (v < 0) return { e: 'score.negative' };
  return { v };
}
function pair(a, b) {
  const pa = num(a), pb = num(b);
  // Report "empty" before other problems, like the legacy UI (which stays silent on blanks).
  for (const k of ['score.empty', 'score.notInteger', 'score.negative'])
    if (pa.e === k || pb.e === k) return { e: k };
  return { a: pa.v, b: pb.v };
}

// Normalise a points rule. tiebreakAt (tennis-style set) means "at tiebreakAt-all, play one
// tiebreak game", i.e. the set is capped at tiebreakAt+1 games.
function rule(r = {}) {
  const to = r.to ?? 21;
  const winBy = r.winBy ?? 2;
  let cap = r.cap ?? null;
  if (r.tiebreakAt != null) cap = r.tiebreakAt + 1;
  return { to, winBy, cap };
}

// A game ends the first moment the leader has `to` with a `winBy` lead, or reaches `cap`.
const terminal = (h, l, { to, winBy, cap }) => (h >= to && h - l >= winBy) || (cap != null && h >= cap);

// Validate a single points game (numbers already parsed). Returns error or null.
// For winBy=2/cap=null the messages and their order mirror legacy scoreError().
function checkPoints(hi, lo, R) {
  const { to, winBy, cap } = R;
  if (hi === lo) return err('score.equal');
  if (hi < to) return err('score.mustReach', { n: to, lo });
  if (cap != null && hi > cap) return err('score.overCap', { cap });
  const atCap = cap != null && hi === cap;
  if (!atCap && hi - lo < winBy)
    return hi === to ? err('score.needLead', { n: winBy }) : err('score.exactLead', { to, n: winBy });
  // Last point must be the one that ended the game.
  if (terminal(hi - 1, lo, R))
    return atCap ? err('score.capRange', { cap, min: cap - winBy }) : err('score.exactLead', { to, n: winBy });
  return null;
}

function validatePoints(result, fmt) {
  const p = pair(result?.a, result?.b);
  if (p.e) return fail(p.e);
  const R = rule(fmt);
  const e = checkPoints(Math.max(p.a, p.b), Math.min(p.a, p.b), R);
  if (e) return { ok: false, error: e, winner: null, score: null, sets: null, units: null };
  const winner = p.a > p.b ? 'a' : 'b';
  return { ok: true, error: null, winner, score: { a: p.a, b: p.b },
           sets: { a: winner === 'a' ? 1 : 0, b: winner === 'b' ? 1 : 0 }, units: { a: p.a, b: p.b } };
}

function validateSetCount(result, fmt) {
  const need = Math.ceil((fmt.bestOf || 3) / 2);
  const p = pair(result?.a, result?.b);
  if (p.e) return fail(p.e);
  const hi = Math.max(p.a, p.b), lo = Math.min(p.a, p.b);
  if (hi > need || lo > need - 1) return fail('sets.countRange', { need, maxLose: need - 1 });
  if (hi !== need) return fail('sets.needWins', { n: need });
  const winner = p.a > p.b ? 'a' : 'b';
  return { ok: true, error: null, winner, score: { a: p.a, b: p.b }, sets: { a: p.a, b: p.b }, units: null };
}

const isBlank = v => v === '' || v === null || v === undefined;
const setSides = s => Array.isArray(s) ? [s[0], s[1]] : [s?.a, s?.b];

function validateSets(result, fmt) {
  if (fmt.entry === 'count') return validateSetCount(result, fmt);
  const bestOf = fmt.bestOf || 3;
  const need = Math.ceil(bestOf / 2);
  const raw = Array.isArray(result?.sets) ? result.sets.map(setSides) : [];
  // Ignore trailing fully-empty sets (unused input rows).
  while (raw.length && isBlank(raw.at(-1)[0]) && isBlank(raw.at(-1)[1])) raw.pop();
  if (!raw.length) return fail('score.empty');

  let wa = 0, wb = 0, ua = 0, ub = 0;
  for (let i = 0; i < raw.length; i++) {
    if (wa === need || wb === need) return fail('sets.afterDecided', { set: i + 1 });
    const p = pair(raw[i][0], raw[i][1]);
    if (p.e) return fail(p.e, { set: i + 1 });
    const R = rule(fmt.decider && i === bestOf - 1 ? fmt.decider : fmt.set);
    const e = checkPoints(Math.max(p.a, p.b), Math.min(p.a, p.b), R);
    if (e) return { ok: false, error: err(e.key, { ...e.params, set: i + 1 }), winner: null, score: null, sets: null, units: null };
    p.a > p.b ? wa++ : wb++;
    ua += p.a; ub += p.b;
  }
  if (wa < need && wb < need) return fail('sets.incomplete', { need });
  const winner = wa > wb ? 'a' : 'b';
  return { ok: true, error: null, winner, score: { a: wa, b: wb }, sets: { a: wa, b: wb }, units: { a: ua, b: ub } };
}

function validateTimed(result, fmt) {
  const p = pair(result?.a, result?.b);
  if (p.e) return fail(p.e);
  const allowDraw = fmt.allowDraw ?? true;
  if (p.a === p.b && !allowDraw) return fail('score.equal');
  const winner = p.a === p.b ? 'draw' : p.a > p.b ? 'a' : 'b';
  return { ok: true, error: null, winner, score: { a: p.a, b: p.b },
           sets: { a: winner === 'a' ? 1 : 0, b: winner === 'b' ? 1 : 0 }, units: { a: p.a, b: p.b } };
}

// No validation: always ok. A winner is derived only when both sides are numbers.
function validateFree(result) {
  const a = Number(result?.a), b = Number(result?.b);
  const known = !isBlank(result?.a) && !isBlank(result?.b) && Number.isFinite(a) && Number.isFinite(b);
  if (!known) return { ok: true, error: null, winner: null, score: null, sets: null, units: null };
  const winner = a === b ? 'draw' : a > b ? 'a' : 'b';
  return { ok: true, error: null, winner, score: { a, b },
           sets: { a: winner === 'a' ? 1 : 0, b: winner === 'b' ? 1 : 0 }, units: { a, b } };
}

export function validateResult(result, matchFormat) {
  const fmt = matchFormat || {};
  switch (fmt.type) {
    case 'points': return validatePoints(result, fmt);
    case 'sets':   return validateSets(result, fmt);
    case 'timed':  return validateTimed(result, fmt);
    case 'free':   return validateFree(result);
    default: throw new Error(`validateResult: unknown matchFormat.type "${fmt.type}"`);
  }
}
