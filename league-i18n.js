// ============================================================================
// league-i18n.js — שלוש שפות לעמודים הציבוריים
//
// למה קובץ נפרד ולא אובייקט בתוך league.js: המחרוזות הן תוכן, לא לוגיקה.
// מי שמתקן ניסוח לא צריך לפתוח קובץ של 3,200 שורות, והמילון ניתן לסקירה
// בשורה אחת לכל מפתח בשלוש השפות זו מתחת לזו.
//
// ⚠️ **הכיוון נשאר RTL בכל השפות.** שמות השחקניות והקבוצות נשארים עברית
// (החלטת המשתמשת), ולכן התוכן של כל שורה בטבלה הוא עברי גם כשהתוויות
// אנגלית. היפוך ה-‎dir‎ היה מחייב מעבר bidi מלא על §1 של league.css, על
// הצמדות הגריד (‎.bg-time‎ דביק מימין) ועל לוח הגרירה — בלי להרוויח דבר
// כשהתוכן עצמו עברי. אם בכל זאת רוצים LTR מלא לאנגלית — זה שלב נפרד.
//
// ⚠️ **מתורגמים העמודים הציבוריים בלבד** (דירוג · לוז · הבראקט ומשחקי
// ההצלבה · דיאלוג הכניסה · מסכי הטעינה והשגיאה). עמודי המנהלת — לוח
// הגרירה, המתזמן, ההגדרות והקבוצות — עדיין עברית. התפר עובר בדיוק בגבול
// ההרשאה: מי שמגיעה לקישור הציבורי מקבלת אתר מתורגם במלואו.
//
// לכן מפתחות ‎ko.*‎ מכסים בדיוק את מה שהצופָה רואה בעמוד הפיינל פור — העץ,
// הכרטיסים, וטבלאות ההצלבה הנגזרות. מה שנשאר למנהלת באותו עמוד (הזנת
// תוצאות · בחירת חצי גמר · ההחלפות) לא מרונדר לצופָה כלל, ולכן גם אינו כאן.
// ============================================================================

export const LANGS = [['he', 'עב'], ['en', 'EN'], ['pt', 'PT']];

const KEY = 'futilina-lang';
let lang = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.some(l => l[0] === saved)) return saved;
    // עברית תמיד, בלי ניחוש מהדפדפן (החלטת המשתמשת 18.8). מי שרוצה
    // אנגלית או פורטוגזית בוחרת במתג, והבחירה נשמרת ל-localStorage.
  } catch (_) {}
  return 'he';
})();

export const getLang = () => lang;

export function setLang(v) {
  if (!LANGS.some(l => l[0] === v)) return;
  lang = v;
  try { localStorage.setItem(KEY, v); } catch (_) {}
  document.documentElement.lang = v;
}

// t('col.pts') · t('sched.found', {n: 4})
export function t(key, vars) {
  let s = DICT[lang]?.[key] ?? DICT.he[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// ── tData: שמות שהמנהלת הקלידה למסמך ────────────────────────────────────────
// "מגרש 2", "מחזור 3", "ליגה ראשונה", "חוף בוגרשוב" — אלה **נתונים**, לא
// כרום, ולכן אינם במילון. שתי דרכים היו אפשריות:
//
//   (א) שדה תרגום לכל שם ב-§5 — ‎nets[].nameEn/namePt‎ וכן הלאה. נכון תמיד,
//       אבל דורש פתיחת §5, שני שדות טקסט לכל מגרש/מחזור/ליגה בעמוד ההגדרות,
//       ו-~28 הקלדות מהמנהלת עוד לפני שהליגה התחילה.
//   (ב) זיהוי התבנית. השמות האלה אינם טקסט חופשי — הם "<מילה> <מספר>" או
//       אחד מתוך רשימה סגורה קצרה, וזה מכסה 100% מהמסמך בפועל.
//
// נבחרה (ב), עם **נפילה שקטה לעברית** לכל מה שלא מזוהה: אם המנהלת תשנה שם
// ל"המגרש ליד הבר", הוא יופיע כך גם באנגלית — לא מתורגם, אבל גם לא שגוי.
// אם יום אחד יידרשו שמות חופשיים מתורגמים, (א) עדיין פתוחה ולא נשללה.
const DATA_EXACT = {
  'פיינל פור':             { en: 'Final Four',  pt: 'Final Four' },
  'משחקי הצלבה':           { en: 'Playoff',     pt: 'Repescagem' },
  'ליגת שואו':             { en: 'Show League', pt: 'Liga Show' },
  'ליגת שאו':              { en: 'Show League', pt: 'Liga Show' },
  // מילה ולא מספר — בעברית כתוב "ראשונה", ולכן גם באנגלית ובפורטוגזית.
  'ליגה ראשונה':           { en: 'First League',  pt: 'Primeira Liga' },
  'ליגה שנייה':            { en: 'Second League', pt: 'Segunda Liga' },
  'ליגה שלישית':           { en: 'Third League',  pt: 'Terceira Liga' },
  'חוף בוגרשוב, תל אביב':  { en: 'Bograshov Beach, Tel Aviv', pt: 'Praia Bograshov, Tel Aviv' }
};

const DATA_PATTERNS = [
  [/^מגרש\s*(\d+)$/,  { en: 'Court {n}', pt: 'Quadra {n}' }],
  [/^רשת\s*(\d+)$/,   { en: 'Court {n}', pt: 'Quadra {n}' }],
  [/^מחזור\s*(\d+)$/, { en: 'Round {n}', pt: 'Rodada {n}' }]
];

export function tData(s) {
  if (lang === 'he' || !s) return s || '';
  const raw = String(s).trim();
  const exact = DATA_EXACT[raw];
  if (exact) return exact[lang] || raw;
  for (const [re, out] of DATA_PATTERNS) {
    const m = raw.match(re);
    if (m) return (out[lang] || raw).split('{n}').join(m[1]);
  }
  return raw;
}

const DICT = {

  he: {
    'nav.standings': 'דירוג',
    'nav.schedule':  'לוז',
    'nav.ko':        'פיינל פור והצלבה',
    'nav.teams':     'קבוצות',
    'nav.sched':     'מתזמן',
    'nav.settings':  'הגדרות',
    'nav.status':    'מצב המערכת',

    'auth.login':   'כניסת מנהלת',
    'auth.master':  'מאסטר',
    'auth.admin':   'אדמין',
    'auth.nopass':  '⚠ ללא סיסמה',
    'auth.nopassT': 'לא הוגדרה סיסמת מאסטר — כל מי שמגיעה לכתובת רואה הכל',
    'auth.pw':      'סיסמה',
    'auth.cancel':  'ביטול',
    'auth.enter':   'כניסה',
    'auth.wrong':   'סיסמה שגויה.',
    'auth.exitT':   'יציאה',
    'auth.exitQ':   'לצאת ממצב מנהלת?',

    'col.rank':   '#',
    'col.team':   'קבוצה',
    'col.played': 'מש׳',
    'col.wins':   'נצ׳',
    'col.losses': 'הפ׳',
    'col.tech':   'טכני',
    'col.abs':    'היעדרות',
    'col.pts':    'נק׳',
    'col.pf':     'לזכות',
    'col.pa':     'לחובה',
    'col.diff':   'הפרש',

    'stand.emptyH': 'אין עדיין דירוג',
    'stand.emptyP': 'הדירוג יופיע כשיהיו קבוצות ומשחקים.',
    'stand.foot':   'מיון: נקודות ← הפרש ← מפגש ישיר ← מיני־ליגה',
    'stand.tie':    'שוויון מלא בין {n} קבוצות על מקומות {places}. התקנון לא מכריע — נדרשת החלטה ידנית',
    'stand.tieF4':  ' (נוגע לגבול הפיינל פור, מקומות 4–5)',
    'stand.tieT':   'שוויון לא מוכרע',
    'drawer.none':  'אין עדיין משחקים מפורסמים לקבוצה הזאת.',

    'ko.tab.ff':    'פיינל פור',
    'ko.tab.cross': 'משחקי הצלבה',
    'ko.bracket':   'הבראקט',
    'ko.rndSemis':  'חצאי גמר',
    'ko.rndFinal':  'גמר',
    'ko.sf0':       'חצי גמר ①',
    'ko.sf1':       'חצי גמר ②',
    'ko.third':     'מקום 3–4',
    'ko.final':     'גמר',
    'ko.wSf1':      'מנצחת חצי ①',
    'ko.wSf2':      'מנצחת חצי ②',
    'ko.lSf1':      'מפסידה חצי ①',
    'ko.lSf2':      'מפסידה חצי ②',
    'ko.seed':      'מק׳ {n}',
    'ko.champOf':   'אלופת {cat}',
    'ko.place2':    'מקום 2',
    'ko.place3':    'מקום 3',
    'ko.bo3':       'הטוב מ-3 · {sets} · {cap}',
    'ko.oneSet':    'מערכה עד {to} · {cap}',
    'ko.cap':       'תקרה {n}',
    'ko.capNone':   'ללא תקרה',
    'ko.noCats':    'אין ליגות מוגדרות.',
    'ko.few':       'ל{cat} יש {n} קבוצות. פיינל פור דורש ארבע מעפילות.',
    'ko.notReady':  'הדירוג עוד לא מספק ארבע קבוצות.',
    'ko.tieBlock':  'שוויון מלא בין {n} קבוצות על מקומות {places} — הוא נוגע לגבול הפיינל פור (4–5). התקנון לא מכריע, ולכן הבראקט לא נבנה עד שההכרעה תירשם ידנית.',
    'ko.tieSeed':   'שוויון לא מוכרע על מקומות {places}. כל הארבע מעפילות, אבל סדר השיבוץ (מי מול מי) תלוי בהכרעה.',

    'ko.x.empty':     'משחקי ההצלבה נגזרים משתי הטבלאות הסופיות של הליגה הראשונה והשנייה.',
    'ko.x.small':     '{cat1} עם {n1} קבוצות בלבד{more} — מנגנון ההצלבה לא ישים (דורש {minN} ומעלה בראשונה, {minM} ומעלה בשנייה). נדרשת החלטה.',
    'ko.x.smallAlso': ' ו{cat2} עם {n2}',
    'ko.x.tie':       'שוויון לא מוכרע ב{cat} על מקומות {places} — הוא נוגע לגבול העלייה/ירידה. ההכרעה חייבת להירשם לפני שההצלבה נקבעת.',
    'ko.x.autoT':     'אוטומטי — בלי משחק',
    'ko.x.from':      'מאיפה',
    'ko.x.rank':      'מקום',
    'ko.x.to':        'לאן',
    'ko.x.last':      'אחרונה',
    'ko.x.last2':     'שנייה מהסוף',
    'ko.x.down':      '⬇ יורדת ל{cat}',
    'ko.x.up':        '⬆ עולה ל{cat}',
    'ko.x.autoFoot':  'הספירה מלמטה: ב-{n} קבוצות ב{cat}, "שתי האחרונות" הן מקומות {places} — המספרים האלה תוצאה של החישוב, לא קלט לו.',
    'ko.x.gamesT':    'משחקי ההצלבה',
    'ko.x.game':      'הצלבה {n}',
    'ko.x.pair3':     'שלישית מהסוף מול מקום 3',
    'ko.x.pair4':     'רביעית מהסוף מול מקום 4',
    'ko.x.gamesFoot': 'המנצחת בכל הצלבה תשחק ב{cat1}, המפסידה ב{cat2}. סה״כ שני משחקים, במועד נפרד אחרי הפיינל פור.',
    'ko.x.nextT':     'הרכב הליגות לעונה הבאה',
    'ko.x.nextWait':  'ממתין לתוצאות ההצלבה — ההרכב למטה מניח שהמצב הנוכחי נשמר, ויתעדכן ברגע שיוזנו התוצאות.',
    'ko.x.tablesT':   'הטבלאות הסופיות',

    'sched.emptyH':  'הלוז עוד לא פורסם',
    'sched.emptyP':  'ברגע שהמנהלת תפרסם מחזור הוא יופיע כאן — עם השעה, המגרש ומי נגד מי.',
    'sched.startsAt': 'מתחילות ב-',
    'sched.search':  'חיפוש קבוצה או שחקנית…',
    'sched.clear':   'נקה',
    'sched.noGames': 'אין משחקים במחזור הזה.',
    'sched.vs':      'נגד',
    'sched.unfin':   'לא הסתיים',
    'sched.found':   '{n} משחקים',
    'sched.allNets': 'כל המגרשים',
    'sched.allCats': 'כל הליגות',
    'sched.notfound':'לא נמצאה קבוצה',

    'sync.saving': 'שומר…',
    'sync.error':  'שגיאת שמירה',
    'sync.ok':     'מסונכרן',
    'lang.aria':   'שפה'
  },

  en: {
    'nav.standings': 'Standings',
    'nav.schedule':  'Schedule',
    'nav.ko':        'Final Four',
    'nav.teams':     'Teams',
    'nav.sched':     'Scheduler',
    'nav.settings':  'Settings',
    'nav.status':    'System',

    'auth.login':   'Manager',
    'auth.master':  'Master',
    'auth.admin':   'Admin',
    'auth.nopass':  '⚠ No password',
    'auth.nopassT': 'No master password is set — anyone with the link sees everything',
    'auth.pw':      'Password',
    'auth.cancel':  'Cancel',
    'auth.enter':   'Sign in',
    'auth.wrong':   'Wrong password.',
    'auth.exitT':   'Sign out',
    'auth.exitQ':   'Sign out of manager mode?',

    'col.rank':   '#',
    'col.team':   'Team',
    'col.played': 'P',
    'col.wins':   'W',
    'col.losses': 'L',
    'col.tech':   'WO',
    'col.abs':    'Abs',
    'col.pts':    'Pts',
    'col.pf':     'For',
    'col.pa':     'Against',
    'col.diff':   'Diff',

    'stand.emptyH': 'No standings yet',
    'stand.emptyP': 'The table appears once there are teams and games.',
    'stand.foot':   'Sorted by: points ← difference ← head-to-head ← mini-league',
    'stand.tie':    '{n} teams are fully tied for places {places}. The rulebook does not break it — a manual decision is needed',
    'stand.tieF4':  ' (on the Final Four line, places 4–5)',
    'stand.tieT':   'Unbroken tie',
    'drawer.none':  'No published games for this team yet.',

    'ko.tab.ff':    'Final Four',
    'ko.tab.cross': 'Playoff',
    'ko.bracket':   'Bracket',
    'ko.rndSemis':  'Semi-finals',
    'ko.rndFinal':  'Final',
    'ko.sf0':       'Semi-final ①',
    'ko.sf1':       'Semi-final ②',
    'ko.third':     '3rd place',
    'ko.final':     'Final',
    'ko.wSf1':      'Winner of SF ①',
    'ko.wSf2':      'Winner of SF ②',
    'ko.lSf1':      'Loser of SF ①',
    'ko.lSf2':      'Loser of SF ②',
    'ko.seed':      'Seed {n}',
    'ko.champOf':   '{cat} champion',
    'ko.place2':    'Runner-up',
    'ko.place3':    '3rd place',
    'ko.bo3':       'Best of 3 · {sets} · {cap}',
    'ko.oneSet':    'Single set to {to} · {cap}',
    'ko.cap':       'cap {n}',
    'ko.capNone':   'no cap',
    'ko.noCats':    'No leagues are defined.',
    'ko.few':       '{cat} has {n} teams. A Final Four needs four qualifiers.',
    'ko.notReady':  'The table does not yet yield four teams.',
    'ko.tieBlock':  '{n} teams are fully tied for places {places} — the tie falls on the Final Four line (4–5). The rulebook does not break it, so the bracket is not built until the tie is settled manually.',
    'ko.tieSeed':   'Unbroken tie for places {places}. All four qualify, but who plays who depends on how it is settled.',

    'ko.x.empty':     'The playoff is derived from the two final tables of the first and second leagues.',
    'ko.x.small':     '{cat1} has only {n1} teams{more} — the playoff mechanism does not apply (it needs {minN}+ in the first league and {minM}+ in the second). A decision is required.',
    'ko.x.smallAlso': ' and {cat2} has {n2}',
    'ko.x.tie':       'Unbroken tie in {cat} for places {places} — it falls on the promotion/relegation line. It must be settled before the playoff is set.',
    'ko.x.autoT':     'Automatic — no game',
    'ko.x.from':      'From',
    'ko.x.rank':      'Place',
    'ko.x.to':        'To',
    'ko.x.last':      'last',
    'ko.x.last2':     'second from last',
    'ko.x.down':      '⬇ down to {cat}',
    'ko.x.up':        '⬆ up to {cat}',
    'ko.x.autoFoot':  'Counted from the bottom: with {n} teams in {cat}, "the bottom two" are places {places} — those numbers are the result of the calculation, not an input to it.',
    'ko.x.gamesT':    'Playoff games',
    'ko.x.game':      'Playoff {n}',
    'ko.x.pair3':     'Third from last vs 3rd place',
    'ko.x.pair4':     'Fourth from last vs 4th place',
    'ko.x.gamesFoot': 'The winner of each playoff plays in {cat1}, the loser in {cat2}. Two games in all, on a separate date after the Final Four.',
    'ko.x.nextT':     'Next season line-up',
    'ko.x.nextWait':  'Waiting for the playoff results — the line-up below assumes the current state holds, and updates as soon as the scores are entered.',
    'ko.x.tablesT':   'Final tables',

    'sched.emptyH':  'The schedule is not published yet',
    'sched.emptyP':  'Once the manager publishes a matchday it shows up here — time, court and who plays who.',
    'sched.startsAt': 'starts at ',
    'sched.search':  'Search team or player…',
    'sched.clear':   'Clear',
    'sched.noGames': 'No games in this matchday.',
    'sched.vs':      'vs',
    'sched.unfin':   'Unfinished',
    'sched.found':   '{n} games',
    'sched.allNets': 'All courts',
    'sched.allCats': 'All leagues',
    'sched.notfound':'No team found',

    'sync.saving': 'Saving…',
    'sync.error':  'Save failed',
    'sync.ok':     'Synced',
    'lang.aria':   'Language'
  },

  pt: {
    'nav.standings': 'Classificação',
    'nav.schedule':  'Jogos',
    'nav.ko':        'Final Four',
    'nav.teams':     'Equipes',
    'nav.sched':     'Gerador',
    'nav.settings':  'Ajustes',
    'nav.status':    'Sistema',

    'auth.login':   'Organização',
    'auth.master':  'Master',
    'auth.admin':   'Admin',
    'auth.nopass':  '⚠ Sem senha',
    'auth.nopassT': 'Nenhuma senha de master definida — quem tiver o link vê tudo',
    'auth.pw':      'Senha',
    'auth.cancel':  'Cancelar',
    'auth.enter':   'Entrar',
    'auth.wrong':   'Senha incorreta.',
    'auth.exitT':   'Sair',
    'auth.exitQ':   'Sair do modo organização?',

    'col.rank':   '#',
    'col.team':   'Equipe',
    'col.played': 'J',
    'col.wins':   'V',
    'col.losses': 'D',
    'col.tech':   'WO',
    'col.abs':    'Aus',
    'col.pts':    'Pts',
    'col.pf':     'PF',
    'col.pa':     'PC',
    'col.diff':   'Saldo',

    'stand.emptyH': 'Ainda não há classificação',
    'stand.emptyP': 'A tabela aparece quando houver equipes e jogos.',
    'stand.foot':   'Ordem: pontos ← saldo ← confronto direto ← mini-liga',
    'stand.tie':    '{n} equipes empatadas nas posições {places}. O regulamento não desempata — é preciso uma decisão manual',
    'stand.tieF4':  ' (na linha do Final Four, posições 4–5)',
    'stand.tieT':   'Empate não resolvido',
    'drawer.none':  'Ainda não há jogos publicados para esta equipe.',

    'ko.tab.ff':    'Final Four',
    'ko.tab.cross': 'Repescagem',
    'ko.bracket':   'Chaveamento',
    'ko.rndSemis':  'Semifinais',
    'ko.rndFinal':  'Final',
    'ko.sf0':       'Semifinal ①',
    'ko.sf1':       'Semifinal ②',
    'ko.third':     '3º lugar',
    'ko.final':     'Final',
    'ko.wSf1':      'Vencedora da SF ①',
    'ko.wSf2':      'Vencedora da SF ②',
    'ko.lSf1':      'Perdedora da SF ①',
    'ko.lSf2':      'Perdedora da SF ②',
    'ko.seed':      '{n}º',
    'ko.champOf':   'Campeã da {cat}',
    'ko.place2':    'Vice',
    'ko.place3':    '3º lugar',
    'ko.bo3':       'Melhor de 3 · {sets} · {cap}',
    'ko.oneSet':    'Set único até {to} · {cap}',
    'ko.cap':       'teto {n}',
    'ko.capNone':   'sem teto',
    'ko.noCats':    'Nenhuma liga definida.',
    'ko.few':       '{cat} tem {n} equipes. O Final Four exige quatro classificadas.',
    'ko.notReady':  'A classificação ainda não define quatro equipes.',
    'ko.tieBlock':  '{n} equipes empatadas nas posições {places} — o empate cai na linha do Final Four (4–5). O regulamento não desempata, então o chaveamento só é montado após uma decisão manual.',
    'ko.tieSeed':   'Empate não resolvido nas posições {places}. As quatro se classificam, mas quem enfrenta quem depende da decisão.',

    'ko.x.empty':     'A repescagem é derivada das duas tabelas finais da primeira e da segunda liga.',
    'ko.x.small':     '{cat1} tem apenas {n1} equipes{more} — o mecanismo da repescagem não se aplica (exige {minN}+ na primeira e {minM}+ na segunda). É preciso uma decisão.',
    'ko.x.smallAlso': ' e {cat2} tem {n2}',
    'ko.x.tie':       'Empate não resolvido em {cat} nas posições {places} — cai na linha de acesso/rebaixamento. Precisa ser resolvido antes de definir a repescagem.',
    'ko.x.autoT':     'Automático — sem jogo',
    'ko.x.from':      'De',
    'ko.x.rank':      'Posição',
    'ko.x.to':        'Para',
    'ko.x.last':      'última',
    'ko.x.last2':     'penúltima',
    'ko.x.down':      '⬇ desce para {cat}',
    'ko.x.up':        '⬆ sobe para {cat}',
    'ko.x.autoFoot':  'A contagem é de baixo: com {n} equipes na {cat}, "as duas últimas" são as posições {places} — esses números são resultado do cálculo, não entrada dele.',
    'ko.x.gamesT':    'Jogos da repescagem',
    'ko.x.game':      'Repescagem {n}',
    'ko.x.pair3':     'Antepenúltima x 3º lugar',
    'ko.x.pair4':     'Quarta do fim x 4º lugar',
    'ko.x.gamesFoot': 'A vencedora de cada repescagem joga na {cat1}, a perdedora na {cat2}. Dois jogos ao todo, em data separada depois do Final Four.',
    'ko.x.nextT':     'Composição da próxima temporada',
    'ko.x.nextWait':  'Aguardando os resultados da repescagem — a composição abaixo assume o estado atual e se atualiza assim que os placares forem lançados.',
    'ko.x.tablesT':   'Tabelas finais',

    'sched.emptyH':  'A tabela de jogos ainda não foi publicada',
    'sched.emptyP':  'Assim que a organização publicar uma rodada ela aparece aqui — horário, quadra e quem joga contra quem.',
    'sched.startsAt': 'começa às ',
    'sched.search':  'Buscar equipe ou jogadora…',
    'sched.clear':   'Limpar',
    'sched.noGames': 'Sem jogos nesta rodada.',
    'sched.vs':      'x',
    'sched.unfin':   'Não terminou',
    'sched.found':   '{n} jogos',
    'sched.allNets': 'Todas as quadras',
    'sched.allCats': 'Todas as ligas',
    'sched.notfound':'Nenhuma equipe encontrada',

    'sync.saving': 'Salvando…',
    'sync.error':  'Falha ao salvar',
    'sync.ok':     'Sincronizado',
    'lang.aria':   'Idioma'
  }
};
