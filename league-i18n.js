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
// ⚠️ **מתורגמים העמודים הציבוריים בלבד** (דירוג · לוז · דיאלוג הכניסה ·
// מסכי הטעינה והשגיאה). עמודי המנהלת — לוח הגרירה, המתזמן, ההגדרות,
// הקבוצות והבראקט — עדיין עברית, כי הם יושבים ב-league-board.js /
// league-sched.js / league-ko.js. התפר עובר בדיוק בגבול ההרשאה: מי
// שמגיעה לקישור הציבורי מקבלת אתר מתורגם במלואו.
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
  'ליגה ראשונה':           { en: 'League 1',    pt: 'Liga 1' },
  'ליגה שנייה':            { en: 'League 2',    pt: 'Liga 2' },
  'ליגה שלישית':           { en: 'League 3',    pt: 'Liga 3' },
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

    'sched.emptyH':  'הלוז עוד לא פורסם',
    'sched.emptyP':  'ברגע שהמנהלת תפרסם מחזור הוא יופיע כאן — עם השעה, המגרש ומי נגד מי.',
    'sched.startsAt': 'מתחילות ב-',
    'sched.search':  'חיפוש קבוצה או שחקנית…',
    'sched.clear':   'נקה',
    'sched.noGames': 'אין משחקים במחזור הזה.',
    'sched.vs':      'נגד',
    'sched.unfin':   'לא הסתיים',
    'sched.found':   '{n} משחקים',
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

    'sched.emptyH':  'The schedule is not published yet',
    'sched.emptyP':  'Once the manager publishes a matchday it shows up here — time, court and who plays who.',
    'sched.startsAt': 'starts at ',
    'sched.search':  'Search team or player…',
    'sched.clear':   'Clear',
    'sched.noGames': 'No games in this matchday.',
    'sched.vs':      'vs',
    'sched.unfin':   'Unfinished',
    'sched.found':   '{n} games',
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

    'sched.emptyH':  'A tabela de jogos ainda não foi publicada',
    'sched.emptyP':  'Assim que a organização publicar uma rodada ela aparece aqui — horário, quadra e quem joga contra quem.',
    'sched.startsAt': 'começa às ',
    'sched.search':  'Buscar equipe ou jogadora…',
    'sched.clear':   'Limpar',
    'sched.noGames': 'Sem jogos nesta rodada.',
    'sched.vs':      'x',
    'sched.unfin':   'Não terminou',
    'sched.found':   '{n} jogos',
    'sched.notfound':'Nenhuma equipe encontrada',

    'sync.saving': 'Salvando…',
    'sync.error':  'Falha ao salvar',
    'sync.ok':     'Sincronizado',
    'lang.aria':   'Idioma'
  }
};
