// core/presets.js — sport presets for the generic engine (data only, not wired yet).
//
// Preset shape:
// {
//   id,
//   terms:     { he:{ entry, entries, court }, en:{ entry, entries, court } },
//   entrySize: { min, max },          // players per entry (pair = 2)
//   allowDraw,                        // can a match end level?
//   matchFormat: { type:'points'|'sets'|'timed'|'free', … }   → see core/scoring.js
//   standings: { points:{ win, draw, loss }, tiebreakers:[…] } → see core/standings.js
//   timing:    { estMinutes },        // default slot length for one match
//   stageFormats?: { pool, r16, qf, sf, third, final }  // optional per-stage overrides
// }
// Tiebreakers: 'points' | 'wins' | 'h2h' | 'setRatio' | 'unitDiff' | 'unitsFor' | 'unitRatio'.

const freeze = o => {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') freeze(v); });
  return Object.freeze(o);
};

const PAIR_TERMS = {
  he: { entry: 'זוג', entries: 'זוגות', court: 'מגרש' },
  en: { entry: 'pair', entries: 'pairs', court: 'court' },
};

// legacy-beach = exactly what app.js does today:
//  - single game per match, win by 2, no cap; target per stage from DEF_KO_RULES
//    (pool 15, r16/qf/sf 18, final 21, third 15). cfg.pointsToWin is NOT used (known bug).
//  - cfg.sets === 3 switches to entering sets won only (2:0 / 2:1).
//  - standings: win 2, loss 1; tiebreak points → wins → point diff → points scored.
const LEGACY_STAGE_PTS = { pool: 15, r16: 18, qf: 18, sf: 18, final: 21, third: 15 };

export const PRESETS = freeze({
  'legacy-beach': {
    id: 'legacy-beach',
    terms: PAIR_TERMS,
    entrySize: { min: 1, max: 2 },
    allowDraw: false,
    matchFormat: { type: 'points', to: 15, winBy: 2, cap: null },
    stageFormats: Object.fromEntries(Object.entries(LEGACY_STAGE_PTS)
      .map(([s, to]) => [s, { type: 'points', to, winBy: 2, cap: null }])),
    standings: { points: { win: 2, draw: 0, loss: 1 }, tiebreakers: ['points', 'wins', 'unitDiff', 'unitsFor'] },
    timing: { estMinutes: 30 },
  },

  'beach-volleyball': { // FIVB: best of 3 sets to 21/21/15, win by 2, no cap
    id: 'beach-volleyball',
    terms: PAIR_TERMS,
    entrySize: { min: 2, max: 2 },
    allowDraw: false,
    matchFormat: { type: 'sets', bestOf: 3, set: { to: 21, winBy: 2, cap: null }, decider: { to: 15, winBy: 2, cap: null } },
    standings: { points: { win: 2, draw: 0, loss: 1 }, tiebreakers: ['points', 'h2h', 'setRatio', 'unitRatio'] },
    timing: { estMinutes: 45 },
  },

  footvolley: { // one set to 18, win by 2, capped at 25 (same as league.js F_SET18)
    id: 'footvolley',
    terms: PAIR_TERMS,
    entrySize: { min: 2, max: 2 },
    allowDraw: false,
    matchFormat: { type: 'points', to: 18, winBy: 2, cap: 25 },
    standings: { points: { win: 2, draw: 0, loss: 1 }, tiebreakers: ['points', 'h2h', 'unitDiff', 'unitsFor'] },
    timing: { estMinutes: 20 },
  },

  padel: { // best of 3 sets to 6 (tiebreak at 6-6 → 7-6), third set = super tiebreak to 10
    id: 'padel',
    terms: PAIR_TERMS,
    entrySize: { min: 2, max: 2 },
    allowDraw: false,
    matchFormat: { type: 'sets', bestOf: 3, set: { to: 6, winBy: 2, tiebreakAt: 6 }, decider: { to: 10, winBy: 2, cap: null } },
    standings: { points: { win: 3, draw: 0, loss: 0 }, tiebreakers: ['points', 'h2h', 'setRatio', 'unitDiff'] },
    timing: { estMinutes: 60 },
  },

  tennis: { // best of 3 sets to 6 with tiebreak at 6-6; full third set
    id: 'tennis',
    terms: {
      he: { entry: 'משתתף', entries: 'משתתפים', court: 'מגרש' },
      en: { entry: 'player', entries: 'players', court: 'court' },
    },
    entrySize: { min: 1, max: 2 },
    allowDraw: false,
    matchFormat: { type: 'sets', bestOf: 3, set: { to: 6, winBy: 2, tiebreakAt: 6 } },
    standings: { points: { win: 1, draw: 0, loss: 0 }, tiebreakers: ['points', 'h2h', 'setRatio', 'unitRatio'] },
    timing: { estMinutes: 90 },
  },

  'generic-points': { // first to 21, any lead
    id: 'generic-points',
    terms: {
      he: { entry: 'קבוצה', entries: 'קבוצות', court: 'מגרש' },
      en: { entry: 'team', entries: 'teams', court: 'court' },
    },
    entrySize: { min: 1, max: 99 },
    allowDraw: false,
    matchFormat: { type: 'points', to: 21, winBy: 1, cap: null },
    standings: { points: { win: 2, draw: 0, loss: 1 }, tiebreakers: ['points', 'wins', 'h2h', 'unitDiff', 'unitsFor'] },
    timing: { estMinutes: 30 },
  },

  'generic-free': { // any result is accepted (draws too); no validation
    id: 'generic-free',
    terms: {
      he: { entry: 'קבוצה', entries: 'קבוצות', court: 'מגרש' },
      en: { entry: 'team', entries: 'teams', court: 'court' },
    },
    entrySize: { min: 1, max: 99 },
    allowDraw: true,
    matchFormat: { type: 'free' },
    standings: { points: { win: 3, draw: 1, loss: 0 }, tiebreakers: ['points', 'h2h', 'unitDiff', 'unitsFor'] },
    timing: { estMinutes: 30 },
  },
});

export const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

export function getPreset(id) {
  return PRESETS[id] || null;
}

// Stage key the way app.js derives it: by distance from the final.
//   pool game: gi === -1 → 'third', else 'pool';  KO: final / sf / qf / r16 (anything earlier)
export function legacyStage(isKO, { gi, ri, koRounds } = {}) {
  if (!isKO) return gi === -1 ? 'third' : 'pool';
  if (!koRounds) return 'pool';
  const fromEnd = koRounds - 1 - (ri ?? 0);
  return fromEnd === 0 ? 'final' : fromEnd === 1 ? 'sf' : fromEnd === 2 ? 'qf' : 'r16';
}

// matchFormat that reproduces legacy isValidScore() for a category cfg + stage:
//   cfg.sets === 3       → sets won entered as a count (2:0 / 2:1)
//   otherwise            → points to {...DEF_KO_RULES, ...cfg.koRules}[stage].pts, win by 2, no cap
//                          (falls back to cfg.pointsToWin || 21 only when that pts is falsy)
export function legacyMatchFormat(cfg = {}, stage = 'pool') {
  if (cfg.sets === 3) return { type: 'sets', bestOf: 3, entry: 'count' };
  const rules = { ...Object.fromEntries(Object.entries(LEGACY_STAGE_PTS).map(([s, pts]) => [s, { pts }])), ...(cfg.koRules || {}) };
  const to = rules[stage]?.pts || cfg.pointsToWin || 21;
  return { type: 'points', to, winBy: 2, cap: null };
}
