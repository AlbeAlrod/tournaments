// Double elimination where the losers' bracket joins at the semifinals.
// The winners' bracket (W) plays down to 2 unbeaten pairs, the losers' bracket (L)
// down to 2 pairs with one loss each; then crossed semifinals (W-top × L-second,
// W-second × L-top), the final, and the 3rd-place game (from the semifinal losers).
// No pair is out before its second loss; from the semifinals it is single elimination.
//
// Rounds come back as W1, W2, …, L1, L2, …, SF, Final (the scheduler orders games by what
// each one waits for). Every game:
//   { a, b, sa:'', sb:'', catId, de: { code, A, B } }
// with A / B = { seed: name } | { w: [ri, gi] } | { l: [ri, gi] } (winner / loser of that game).
// Byes are resolved here: a pair without an opponent goes straight on, so no game is a bye.
export function buildDE(names, catId) {
  let P = 4;
  while (P < names.length) P *= 2;
  const seeds = Array.from({ length: P }, (_, i) => names[i] ?? null);
  const rounds = [];                          // [{ kind:'W'|'L'|'SF'|'F', games:[{A, B}] }]
  const add = (kind, pairs) => {
    const games = pairs.map(([A, B]) => ({ A, B }));
    rounds.push({ kind, games });
    return games;
  };
  const win = g => ({ w: g }), lose = g => ({ l: g });
  const pairUp = list => list.reduce((o, x, i) => (i % 2 ? o[o.length - 1].push(x) : o.push([x]), o), []);

  let wb = add('W', Array.from({ length: P / 2 }, (_, i) => [{ seed: seeds[i] }, { seed: seeds[P - 1 - i] }]));
  const wbRounds = [wb];
  while (wb.length > 2) { wb = add('W', pairUp(wb.map(win))); wbRounds.push(wb); }

  // Losers' bracket: first-round losers play each other, then each later winners' round
  // drops its losers in (reversed every other round, to avoid quick rematches).
  let lb = wbRounds[0].map(lose);
  if (wbRounds.length > 1) {
    lb = add('L', pairUp(lb)).map(win);
    for (let k = 1; k < wbRounds.length; k++) {
      const drops = wbRounds[k].map(lose);
      if (k % 2) drops.reverse();
      lb = add('L', lb.map((x, j) => [x, drops[j]])).map(win);
      if (k < wbRounds.length - 1) lb = add('L', pairUp(lb)).map(win);
    }
  }
  const sf = add('SF', [[win(wb[0]), lb[1]], [win(wb[1]), lb[0]]]);
  add('F', [[win(sf[0]), win(sf[1])]]);

  // Byes: a side with no pair (empty seed, the loser of a bye) lets the other side through.
  const through = s => (s && s.w && s.w.bye) ? through(s.w.through) : s;
  const empty = s => !s || (s.seed !== undefined ? s.seed == null : !!(s.l && s.l.bye));
  rounds.forEach(r => r.games.forEach(g => {
    g.A = g.A && through(g.A); g.B = g.B && through(g.B);
    const ea = empty(g.A), eb = empty(g.B);
    if (ea || eb) { g.bye = true; g.through = ea ? (eb ? null : g.B) : g.A; }
  }));

  // Index the real games and write the stored shape.
  const out = [];
  let wn = 0, ln = 0;
  rounds.forEach(r => {
    const games = r.games.filter(g => !g.bye);
    if (!games.length) return;
    const ri = out.length;
    const code = r.kind === 'W' ? `W${++wn}` : r.kind === 'L' ? `L${++ln}` : r.kind;
    games.forEach((g, gi) => { g.ri = ri; g.gi = gi; g.code = r.kind === 'F' ? 'Final' : `${code}-${gi + 1}`; });
    if (r.kind === 'SF') games.forEach((g, gi) => { g.code = `SF${gi + 1}`; });
    out.push(games);
  });
  const ref = s => s.seed !== undefined ? { seed: s.seed } : s.w ? { w: [s.w.ri, s.w.gi] } : { l: [s.l.ri, s.l.gi] };
  return out.map(games => games.map(g => ({
    a: '', b: '', sa: '', sb: '', catId, de: { code: g.code, A: ref(g.A), B: ref(g.B) }
  })));
}

// Ids of the games a double-elimination game waits for.
export const deDeps = g => [g.de.A, g.de.B].filter(s => s.w || s.l).map(s => s.w || s.l);

// Fills a / b of every unplayed game from the results so far.
export function resolveDE(ko, winner, loser) {
  const nameOf = s => {
    if (s.seed !== undefined) return s.seed;
    const [ri, gi] = s.w || s.l, x = ko[ri]?.[gi];
    if (!x) return 'TBD';
    return (s.w ? winner(x) : loser(x)) || `${s.w ? 'Winner' : 'Loser'} of ${x.de.code}`;
  };
  ko.forEach(r => r.forEach(g => {
    if (!g?.de || String(g.sa ?? '') !== '' || String(g.sb ?? '') !== '') return;
    g.a = nameOf(g.de.A); g.b = nameOf(g.de.B);
  }));
}
