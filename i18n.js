// ============================================================================
// i18n.js — Hebrew / English for the tournament app (index.html + app.js)
//
// Modelled on league-i18n.js, with one deliberate difference: here `dir`
// FOLLOWS the language (WORKPLAN "Decisions already taken"). styles.css is
// written with logical properties, so the layout mirrors on its own.
//
// Rules for whoever wires this in (full guide: I18N_WIRING.md):
//   • Translate at RENDER time only. Values stored in Firestore — "TBD",
//     "Loser of SF1", "Winner of Semifinals 1", "BYE", "New Category" seeds —
//     are matched by app.js logic (startsWith('Winner'), /^[A-Z]\d+$/ …) and
//     must stay exactly as they are. Use tSlot() to display them.
//   • User content (pair names, category names, notes) is never translated.
//   • Every key exists in BOTH dictionaries (parity check: I18N_WIRING.md §9).
//
// API
//   initLang(defaultLang)   localStorage('luz-lang') → defaultLang → 'he'
//   getLang()               'he' | 'en'
//   setLang(lang)           sets <html lang dir>, stores, fires 'langchange'
//   t(key, vars)            "{n} זוגות" + {n:3}; uses key+'_one' when vars.n===1
//   applyStatic(root)       fills [data-i18n] [data-i18n-html] [data-i18n-ph]
//                           [data-i18n-title] [data-i18n-aria]
//   fmtDate(d) / fmtTime(d) Date | ms | Firestore Timestamp | 'HH:MM'
//   tRound(fromEnd, size)   localized knockout round name
//   tSlot(s)                localized placeholder for stored KO slot strings
// ============================================================================

export const LANGS = [['he', 'עב'], ['en', 'EN']];
const SUPPORTED = LANGS.map(l => l[0]);
const STORE_KEY = 'luz-lang';

let lang = 'he';

const isLang = v => SUPPORTED.includes(v);
export const dirOf = l => (l === 'he' ? 'rtl' : 'ltr');
export const getLang = () => lang;
export const isRTL = () => dirOf(lang) === 'rtl';

function applyToDocument() {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.lang = lang;
  html.dir = dirOf(lang);
}

// Picks the starting language: the viewer's saved choice wins, then the
// tournament's meta.lang, then Hebrew. Does NOT fire 'langchange' (nothing
// has rendered yet); call applyStatic() afterwards.
export function initLang(defaultLang) {
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch (_) {}
  lang = isLang(saved) ? saved : isLang(defaultLang) ? defaultLang : 'he';
  applyToDocument();
  return lang;
}

// Viewer switched language. Persists the choice and notifies listeners:
//   window.addEventListener('langchange', e => { applyStatic(); renderAll(); })
export function setLang(next) {
  if (!isLang(next)) return lang;
  const changed = next !== lang;
  lang = next;
  try { localStorage.setItem(STORE_KEY, next); } catch (_) {}
  applyToDocument();
  if (changed && typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }
  return lang;
}

// t('build.pairsCount', {n: 3}) → "3 זוגות";  {n: 1} → "זוג אחד" (via _one)
export function t(key, vars) {
  const d = DICT[lang] || DICT.he;
  let s;
  if (vars && Number(vars.n) === 1) s = d[key + '_one'] ?? DICT.he[key + '_one'];
  if (s === undefined) s = d[key] ?? DICT.he[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

export const hasKey = (key, l = lang) => Object.prototype.hasOwnProperty.call(DICT[l] || {}, key);

// Static markup: <h2 data-i18n="stand.title">Standings</h2>
//   data-i18n        → textContent
//   data-i18n-html   → innerHTML (dictionary strings only — never user data)
//   data-i18n-ph     → placeholder
//   data-i18n-title  → title
//   data-i18n-aria   → aria-label
export function applyStatic(root = document) {
  if (!root || !root.querySelectorAll) return;
  const each = (attr, fn) => root.querySelectorAll('[' + attr + ']').forEach(el => fn(el, el.getAttribute(attr)));
  each('data-i18n',       (el, k) => { el.textContent = t(k); });
  each('data-i18n-html',  (el, k) => { el.innerHTML = t(k); });
  each('data-i18n-ph',    (el, k) => { el.setAttribute('placeholder', t(k)); });
  each('data-i18n-title', (el, k) => { el.setAttribute('title', t(k)); });
  each('data-i18n-aria',  (el, k) => { el.setAttribute('aria-label', t(k)); });
}

const LOCALE = { he: 'he-IL', en: 'en-GB' };

function toDate(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'object') {
    if (typeof d.toDate === 'function') return d.toDate();          // Firestore Timestamp
    if (typeof d.seconds === 'number') return new Date(d.seconds * 1000);
  }
  const x = new Date(d);
  return isNaN(x) ? null : x;
}

// 7 Oct 2026 / 7 באוק׳ 2026. Returns '' for missing dates (e.g. a
// registration whose serverTimestamp has not resolved yet) instead of 1970.
export function fmtDate(d) {
  const x = toDate(d);
  if (!x || x.getTime() === 0) return '';
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(x);
}

// Always 24h "17:40". Accepts the app's own 'HH:MM' strings unchanged.
export function fmtTime(d) {
  if (typeof d === 'string' && /^\d{1,2}:\d{2}$/.test(d)) return d;
  const x = toDate(d);
  if (!x) return '';
  return new Intl.DateTimeFormat(LOCALE[lang], { hour: '2-digit', minute: '2-digit', hour12: false }).format(x);
}

// Knockout round name by position from the end (0 = final). `size` (games
// in the round × 2) is only used past the round of 16.
export function tRound(fromEnd, size) {
  if (fromEnd === 0) return t('bracket.round.final');
  if (fromEnd === 1) return t('bracket.round.sf');
  if (fromEnd === 2) return t('bracket.round.qf');
  if (fromEnd === 3) return t('bracket.round.r16');
  return t('bracket.round.of', { n: size || Math.pow(2, fromEnd + 1) });
}

// English round names that app.js writes into stored slot strings
// ("Winner of Quarterfinals 3"). Maps them back to a position from the end.
const ROUND_FROM_END = { 'Final': 0, 'Semifinals': 1, 'Quarterfinals': 2, 'Round of 16': 3 };

// Display text for a stored knockout slot. Real pair names pass through.
export function tSlot(s) {
  if (s == null || s === '') return t('bracket.tbd');
  const str = String(s);
  if (str === 'TBD') return t('bracket.tbd');
  if (str === 'BYE') return t('bracket.bye');
  let m = str.match(/^Loser of SF(\d+)$/);
  if (m) return t('bracket.loserSf', { n: m[1] });
  m = str.match(/^Winner of (.+) (\d+)$/);
  if (m) {
    const name = m[1];
    const of = name.match(/^Round of (\d+)$/);
    const round = name in ROUND_FROM_END ? tRound(ROUND_FROM_END[name])
      : of ? t('bracket.round.of', { n: of[1] }) : name;
    return t('bracket.winnerOf', { round, n: m[2] });
  }
  return str;
}

// ============================================================================
// Dictionaries. One key per line, Hebrew first. Hebrew copy is gender-neutral:
// plural imperative ("לחצו") or infinitive ("יש ללחוץ"), never feminine-only.
// Terms: זוג/זוגות · מגרש · בית · שלב הבתים · שלב הנוקאאוט · שמינית גמר ·
// רבע גמר · חצי גמר · גמר · מקום שלישי.
// ============================================================================
const DICT = {

  he: {
    // ── common ──
    'common.appName':      'טורנירים',
    'common.tournament':   'טורניר',
    'common.loading':      'טוען…',
    'common.expiredH':     'הטורניר הסתיים',
    'common.expiredP':     'עמוד הטורניר הזה כבר לא פעיל.',
    'common.noTournamentH':'טורנירים',
    'common.noTournamentP':'לא צוין טורניר. יש להוסיף <code>?t=tournament-id</code> לכתובת.',
    'common.cancel':       'ביטול',
    'common.confirm':      'אישור',
    'common.save':         'שמירה',
    'common.add':          'הוספה',
    'common.addPlus':      '+ הוספה',
    'common.edit':         'עריכה',
    'common.remove':       'הסרה',
    'common.delete':       'מחיקה',
    'common.reset':        'איפוס',
    'common.all':          'הכול',
    'common.vs':           'נגד',
    'common.player1':      'שחקן/ית 1',
    'common.player2':      'שחקן/ית 2',
    'common.buildFirst':   'יש לבנות את הטורניר קודם.',
    'common.dash':         '—',

    'common.nav.aria':          'ניווט ראשי',
    'common.nav.register':      'הרשמה',
    'common.nav.participants':  'נרשמים',
    'common.nav.registrations': 'בקשות הרשמה',
    'common.nav.build':         'בניית הטורניר',
    'common.nav.standings':     'טבלאות',
    'common.nav.schedule':      'לוח משחקים',
    'common.nav.bracket':       'שלב הנוקאאוט',
    'common.nav.settings':      'הגדרות',

    'lang.aria': 'שפה',
    'lang.he':   'עב',
    'lang.en':   'EN',

    // ── admin / login / mode bar / registrations page ──
    'admin.btn':            'ניהול',
    'admin.btnAdminOn':     'אדמין ✓',
    'admin.btnMasterOn':    'מאסטר ✓',
    'admin.modeHint':       'לניהול — לחצו על "ניהול"',
    'admin.modeView':       'צפייה בלבד — לניהול לחצו על "ניהול"',
    'admin.modeMasterReg':  'מצב מאסטר — גישה מלאה',
    'admin.modeAdminReg':   'מצב אדמין — אישור נרשמים והוספת זוגות',
    'admin.modeMasterBuilt':'מצב מאסטר — הטורניר בנוי',
    'admin.modeAdminBuilt': 'מצב אדמין — עריכת הזוגות',
    'admin.modeScores':     'מצב אדמין — הזנת תוצאות',
    'admin.loginTitle':     'כניסה',
    'admin.roleAdmin':      'אדמין',
    'admin.roleMaster':     'מאסטר',
    'admin.pwPh':           'סיסמה',
    'admin.pwWrong':        'הסיסמה שגויה.',
    'admin.loginBtn':       'כניסה',
    'admin.regsTitle':      'בקשות הרשמה',
    'admin.filterAll':      'הכול',
    'admin.filterPending':  'ממתינים',
    'admin.filterApproved': 'אושרו',
    'admin.filterRejected': 'נדחו',
    'admin.status.pending': 'ממתין',
    'admin.status.approved':'אושר',
    'admin.status.rejected':'נדחה',
    'admin.noRegs':         'אין בקשות הרשמה',
    'admin.approve':        'אישור',
    'admin.undo':           'ביטול אישור',
    'admin.delete':         'מחיקה',
    'admin.deleteTitle':    'מחיקה לצמיתות',
    'admin.confirmDelete':  'למחוק את ההרשמה הזאת לצמיתות? אפשר במקום זה לדחות אותה.',
    'admin.noPhone':        '—',

    // ── registration form ──
    'reg.title':        'הרשמה',
    'reg.subtitle':     'הרשמה ל{name}',
    'reg.closed':       'ההרשמה סגורה כרגע.',
    'reg.p1Label':      'שם שחקן/ית 1',
    'reg.p2Label':      'שם שחקן/ית 2',
    'reg.namePh':       'שם מלא',
    'reg.phoneLabel':   'טלפון',
    'reg.catLabel':     'קטגוריה',
    'reg.ok':           'ההרשמה נשלחה! נעדכן אתכם כשהיא תאושר.',
    'reg.submit':       'שליחת הרשמה',
    'reg.payment':      'תשלום',
    'reg.payLink':      'לתשלום',
    'reg.payLink2':     'לתשלום (2)',

    // ── participants ──
    'parts.title':    'הזוגות הרשומים',
    'parts.subtitle': 'הרשמות שאושרו',
    'parts.hidden':   'רשימת הנרשמים עדיין לא פורסמה.',
    'parts.empty':    'עדיין אין זוגות מאושרים',

    // ── build ──
    'build.title':          'בניית הטורניר',
    'build.subtitle':       'סדרו את הזוגות בגרירה, ואז בנו את הטורניר.',
    'build.builtBanner':    '✓ הטורניר בנוי — עדיין אפשר לערוך זוגות ולבנות מחדש',
    'build.pairsCount':     '{n} זוגות',
    'build.pairsCount_one': 'זוג אחד',
    'build.build':          '▶ בניית הטורניר',
    'build.rebuild':        '↺ בנייה מחדש',
    'build.shuffle':        'ערבוב',
    'build.addPair':        '+ הוספת זוג',
    'build.moveUp':         'הזזה למעלה',
    'build.moveDown':       'הזזה למטה',
    'build.startNoteBuilt': 'הטורניר בנוי ומוכן. לוחצים "התחלת הטורניר" בתחילת התחרות.<br>אחרי זה כבר אי אפשר לשנות הגדרות.',
    'build.startNoteReg':   'קודם בונים את כל הקטגוריות, ואז מפעילים את הטורניר.',
    'build.start':          '▶ התחלת הטורניר',
    'build.startQ':         'להתחיל את הטורניר?',
    'build.startBody':      'מומלץ לעשות את זה ממש בתחילת התחרות. אחרי ההתחלה כבר אי אפשר לשנות זוגות והגדרות.',
    'build.editPair':       'עריכת זוג',
    'build.addPairTitle':   'הוספת זוג ישירות',
    'build.confirmRemove':  'להסיר את "{name}" מהטורניר?',
    'build.confirmRemoveAnon': 'להסיר את הזוג הזה?',

    // ── standings ──
    'stand.title':        'טבלאות',
    'stand.group':        'בית {name}',
    'stand.col.team':     'זוג',
    'stand.col.w':        'נצ׳',
    'stand.col.l':        'הפ׳',
    'stand.col.diff':     '+/−',
    'stand.col.pts':      'נק׳',
    'stand.emptyH':       'עדיין אין נתוני טורניר',
    'stand.editTitle':    'עריכה — בית {name}',
    'stand.editAria':     'עריכת הזוג',
    'stand.removeAria':   'הסרת הזוג',
    'stand.confirmRemove':'להסיר את "{name}" מבית {group}?',

    // ── schedule ──
    'sched.searchPh':    'חיפוש זוג…',
    'sched.searchAria':  'חיפוש זוג בלוח המשחקים',
    'sched.statPool':    'משחקי בתים ששוחקו',
    'sched.statKO':      'משחקי נוקאאוט',
    'sched.statEnd':     'סיום מתוכנן',
    'sched.court':       'מגרש {n}',
    'sched.courtShort':  'מ{n}',
    'sched.vs':          'נגד',
    'sched.emptyH':      'עדיין אין לוח משחקים',
    'sched.noGames':     'אין משחקים',
    'sched.noMatch':     'לא נמצא "{q}"',
    'sched.pools':       'שלב הבתים',
    'sched.third':       'מקום שלישי',
    'sched.subLabel':    '{cat} — {stage}',
    'sched.rule':        ' (עד {pts})',
    'sched.ruleSwitch':  ' (עד {pts}, החלפת צד כל {change})',
    'sched.breakDefault':'הפסקה',
    'sched.breakLine':   '{note} — הפסקה של {min} דק׳ · {from}–{to} · כל המגרשים',
    'sched.scoreA':      'תוצאת הצד הראשון',
    'sched.scoreB':      'תוצאת הצד השני',

    // ── bracket ──
    'bracket.title':        'שלב הנוקאאוט',
    'bracket.noPool':       'שלב הבתים עוד לא שובץ.',
    'bracket.poolInfo':     'שלב הבתים: {progress} — העץ מתעדכן בזמן אמת',
    'bracket.poolPlayed':   '{done}/{total} שוחקו',
    'bracket.round.final':  'גמר',
    'bracket.round.sf':     'חצי גמר',
    'bracket.round.qf':     'רבע גמר',
    'bracket.round.r16':    'שמינית גמר',
    'bracket.round.of':     'שלב {n} האחרונים',
    'bracket.lbl.final':    'גמר',
    'bracket.lbl.sf':       'חצי {n}',
    'bracket.lbl.qf':       'רבע {n}',
    'bracket.lbl.r16':      'שמינית {n}',
    'bracket.lbl.game':     'משחק {n}',
    'bracket.third':        'מקום שלישי',
    'bracket.champion':     'אלופים',
    'bracket.direct':       'עולה ישירות',
    'bracket.tbd':          'ייקבע',
    'bracket.bye':          'פטור',
    'bracket.loserSf':      'המפסידים בחצי גמר {n}',
    'bracket.winnerOf':     'המנצחים ב{round} {n}',

    // ── score validation (app.js scoreError today, core/scoring.js later) ──
    'score.nonNegative':     'התוצאה לא יכולה להיות שלילית',
    'score.setsFormat':      'מערכות: 2:0 או 2:1',
    'score.setsWinner':      'למנצחים צריכות להיות 2 מערכות',
    'score.noDraw':          'אין תיקו — התוצאות לא יכולות להיות שוות',
    'score.mustReach':       'צריך להגיע ל-{n}',
    'score.mustReachEg':     'צריך להגיע ל-{n} · למשל {n}–{lo}',
    'score.needLead':        'צריך יתרון של {n} נקודות',
    'score.exactlyTwoAbove': 'מעל {n}: הפרש של 2 בדיוק',

    // ── settings ──
    'settings.title':          'הגדרות',
    'settings.design':         'עיצוב',
    'settings.name':           'שם הטורניר',
    'settings.namePh':         'שם הטורניר',
    'settings.primary':        'צבע ראשי',
    'settings.primaryDesc':    'הצבע המוביל — כותרות וכפתורים',
    'settings.secondary':      'צבע משני',
    'settings.secondaryDesc':  'מעברי צבע וכפתורי הדגשה',
    'settings.preview':        'תצוגה מקדימה',
    'settings.bg':             'צבע רקע',
    'settings.bgDesc':         'דריסה של רקע האתר',
    'settings.logo':           'לוגו',
    'settings.logoUrl':        'כתובת הלוגו',
    'settings.logoDesc':       'תמונת הלוגו של הטורניר',
    'settings.groupColors':    'צבעי הבתים',
    'settings.sponsors':       'ספונסרים',
    'settings.sponsorUrlPh':   'כתובת התמונה…',
    'settings.sponsorNamePh':  'שם…',
    'settings.noSponsors':     'עדיין אין ספונסרים — אפשר להוסיף למטה.',
    'settings.addSponsor':     '+ הוספת ספונסר',
    'settings.players':        'מאגר שחקנים',
    'settings.playerNamePh':   'שם השחקן/ית…',
    'settings.playerPhonePh':  'טלפון (לא חובה)',
    'settings.importPlayers':  '↓ ייבוא כל השחקנים מהטורניר הזה',
    'settings.playersCount':   '{n} שחקנים',
    'settings.playersCount_one':'שחקן/ית אחד/ת',
    'settings.noPlayers':      'עדיין אין שחקנים — אפשר לייבא או להוסיף זוגות דרך החלון.',
    'settings.imported':       'יובאו {n} שחקנים חדשים.',
    'settings.imported_one':   'יובא שחקן/ית חדש/ה אחד/ת.',
    'settings.allImported':    'כל השחקנים כבר נמצאים במאגר.',
    'settings.groups':         'בתים',
    'settings.groupLabel':     'בית',
    'settings.teamsCount':     '{n} זוגות',
    'settings.teamsCount_one': 'זוג אחד',
    'settings.moveTo':         'העברה ל…',
    'settings.moveToGroup':    'בית {name}',
    'settings.sport':          'ענף',
    'settings.sportDesc':      'בכדורעף החוף לא מוצגת ההערה "(עד 21, החלפת צד כל 7)" — המשחק תמיד עד 21. בפוטבולי מוצגות הנקודות שהוגדרו לכל שלב.',
    'settings.sportFootvolley':'פוטבולי / מותאם אישית',
    'settings.sportVolleyball':'כדורעף חופים (עד 21)',
    'settings.registration':   'הרשמה',
    'settings.regOpen':        'ההרשמה פתוחה',
    'settings.showList':       'פרסום רשימת הנרשמים',
    'settings.regNote':        'הערה לנרשמים',
    'settings.regNoteDesc':    'מוצגת מעל טופס ההרשמה.',
    'settings.regNotePh':      'למשל: התשלום עד יום שישי…',
    'settings.payLinks':       'קישורי תשלום',
    'settings.payLinksDesc':   'מוצגים בטופס ההרשמה.',
    'settings.labelPh':        'תווית…',
    'settings.urlOptionalPh':  'https://… (לא חובה)',
    'settings.categories':     'קטגוריות',
    'settings.addCategory':    'הוספת קטגוריה',
    'settings.addCategoryDesc':'יצירת קטגוריה חדשה בטורניר',
    'settings.newCategory':    'קטגוריה חדשה',
    'settings.deleteCategory': 'מחיקת הקטגוריה',
    'settings.confirmDeleteCat':'למחוק את הקטגוריה הזאת?',
    'settings.cantDeleteCat':  'אי אפשר למחוק קטגוריות בזמן טורניר פעיל.',
    'settings.start':          'התחלת הטורניר',
    'settings.startNote':      'כשכל הזוגות מוכנים, מתחילים את הטורניר.<br>אחרי זה כבר אי אפשר לשנות זוגות והגדרות.',
    'settings.confirmResetScores': 'לאפס את כל התוצאות?',
    'settings.courts':         'מגרשים',
    'settings.numGroups':      'בתים',
    'settings.advPerGroup':    'עולים מכל בית',
    'settings.gameDur':        'דקות למשחק',
    'settings.breakDur':       'דקות הפסקה',
    'settings.sets':           'מערכות',
    'settings.thirdSetPts':    'נק׳ במערכה שלישית',
    'settings.startTime':      'שעת התחלה',
    'settings.scoringRules':   'חוקי ניקוד',
    'settings.rules.stage':    'שלב',
    'settings.rules.pts':      'נק׳ לניצחון',
    'settings.rules.switch':   'החלפת צד כל',
    'settings.rules.min':      'דק׳',
    'settings.stage.pool':     'שלב הבתים',
    'settings.stage.r16':      'שמינית גמר',
    'settings.stage.qf':       'רבע גמר',
    'settings.stage.sf':       'חצי גמר',
    'settings.stage.third':    'מקום שלישי',
    'settings.stage.final':    'גמר',

    // ── errors / alerts ──
    'errors.p1Required':   'יש למלא את שם שחקן/ית 1.',
    'errors.catRequired':  'יש לבחור קטגוריה.',
    'errors.submitFailed': 'השליחה נכשלה. נסו שוב.',
    'errors.statusUpdate': 'עדכון הסטטוס נכשל. נסו שוב.',
    'errors.noApproved':   'אין זוגות מאושרים בקטגוריה הזאת.',
    'errors.groupMin':     'בבית צריך להישאר לפחות זוג אחד.',

    // ── wave 2: receipt, not-found, registration tools, uploader ──
    'common.notFoundH':        'הטורניר לא נמצא',
    'common.notFoundP':        'לא מצאנו את הטורניר הזה. בדקו את הקישור שקיבלתם, או בקשו מהמארגנים לשלוח אותו שוב.',
    'reg.soon':                'ההרשמה תיפתח בקרוב.',
    'reg.sending':             'שליחה…',
    'reg.mine':                'ההרשמות שלכם מהדפדפן הזה:',
    'reg.cancelContact':       'לביטול יש לפנות למארגנים.',
    'reg.confirmCancel':       'לבטל את ההרשמה?',
    'reg.receiptTitle':        'ההרשמה התקבלה ✓',
    'reg.receiptPair':         'זוג',
    'reg.receiptStatus':       'סטטוס',
    'reg.pendingApproval':     'ממתין לאישור',
    'reg.payNote':             'נא לכתוב את השמות בהערת התשלום.',
    'reg.another':             'הרשמת זוג נוסף',
    'admin.paid':              'שולם',
    'admin.filterPaidAll':     'שולם + לא שולם',
    'admin.filterPaid':        'שולם',
    'admin.filterUnpaid':      'לא שולם',
    'admin.searchPh':          'חיפוש שם או טלפון…',
    'admin.searchAria':        'חיפוש בבקשות ההרשמה',
    'admin.exportCsv':         'ייצוא CSV',
    'settings.info':           'פרטי הטורניר',
    'settings.infoDesc':       'לא חובה. מוצג בראש עמודי ההרשמה ולוח המשחקים.',
    'settings.eventDate':      'תאריך האירוע',
    'settings.venue':          'מקום',
    'settings.venuePh':        'מקום, למשל חוף גורדון',
    'settings.price':          'מחיר',
    'settings.pricePh':        'מחיר, למשל ₪150 לזוג',
    'settings.lang':           'שפת ברירת המחדל',
    'settings.langDesc':       'הצופים יכולים להחליף שפה בכותרת.',
    'settings.logoUploadDesc': 'העלאת תמונה (PNG/JPG/WebP — מוקטנת אוטומטית) או הדבקת כתובת של תמונה.',
    'settings.logoDropAria':   'העלאת לוגו: לחיצה, גרירה או הדבקה של תמונה',
    'settings.logoDropHint':   'גררו לכאן לוגו, לחצו לבחירה, או הדביקו',
    'settings.logoCurrent':    'הלוגו הנוכחי',
    'settings.removeLogo':     'הסרת הלוגו',
    'settings.uploadedPh':     'תמונה שהועלתה — הדביקו כתובת כדי להחליף',
    'settings.upload':         'העלאה',
    'errors.nameRequired':     'יש למלא את השם של {who}.',
    'errors.nameTooLong':      'השם של {who} ארוך מדי (עד {max} תווים).',
    'errors.nameSlash':        'השם של {who} לא יכול להכיל "/".',
    'errors.sameNames':        'שחקן/ית 1 ושחקן/ית 2 צריכים להיות אנשים שונים.',
    'errors.phoneRequired':    'יש למלא מספר טלפון.',
    'errors.phoneInvalid':     'יש להזין מספר נייד תקין: 05X-XXXXXXX, או מספר בינלאומי שמתחיל ב-+.',
    'errors.dupPair':          'הזוג הזה כבר רשום בקטגוריה (סטטוס: {status}).',
    'errors.dupPhone':         'מספר הטלפון הזה כבר רשום בקטגוריה (סטטוס: {status}).',
    'errors.cancelFailed':     'הביטול נכשל. נסו שוב.',
    'errors.paidUpdate':       'עדכון התשלום נכשל.',
    'errors.uploadFailed':     'ההעלאה נכשלה.',
    'errors.metaFull':         'אין מספיק מקום לתמונה הזאת. הסירו ספונסר או לוגו, או השתמשו בכתובת של תמונה.',
    'upload.notImage':         'יש לבחור קובץ תמונה (PNG, JPG או WebP).',
    'upload.svg':              'קובצי SVG לא נתמכים — השתמשו ב-PNG, JPG או WebP.',
    'upload.decode':           'לא הצלחנו לקרוא את התמונה. נסו לשמור אותה כ-PNG או JPG.',
    'upload.tooBig':           'לא הצלחנו להקטין את התמונה מספיק. נסו תמונה פשוטה או קטנה יותר.',
    'upload.huge':             'הקובץ גדול מדי (עד 15MB).',
    'admin.modeMasterScores':  'מצב מאסטר — הזנת תוצאות',
    'csv.status':              'סטטוס',
    'csv.created':             'נרשם בתאריך',
    'csv.yes':                 'כן',
    'csv.no':                  'לא',
    'common.back':             'חזרה',
    'admin.reject':            'דחייה',
    'reg.cancelReg':           'ביטול ההרשמה',
    'reg.cancelled':           'ההרשמה בוטלה',
    'sched.scoreFor':          'תוצאה של {team}',
    'score.bothSides':         'יש למלא את התוצאה של שני הצדדים',

    // ── sport terms (for the multi-sport engine; not wired yet) ──
    'terms.pair':    'זוג',
    'terms.pairs':   'זוגות',
    'terms.team':    'קבוצה',
    'terms.teams':   'קבוצות',
    'terms.player':  'שחקן/ית',
    'terms.players': 'שחקנים',
    'terms.group':   'בית',
    'terms.groups':  'בתים',
    'terms.court':   'מגרש',
    'terms.courts':  'מגרשים',
    'terms.set':     'מערכה',
    'terms.sets':    'מערכות'
  },

  en: {
    'common.appName':      'Tournaments',
    'common.tournament':   'Tournament',
    'common.loading':      'Loading…',
    'common.expiredH':     'Tournament ended',
    'common.expiredP':     'This tournament page is no longer active.',
    'common.noTournamentH':'Tournaments',
    'common.noTournamentP':'No tournament specified. Add <code>?t=tournament-id</code> to the URL.',
    'common.cancel':       'Cancel',
    'common.confirm':      'Confirm',
    'common.save':         'Save',
    'common.add':          'Add',
    'common.addPlus':      '+ Add',
    'common.edit':         'Edit',
    'common.remove':       'Remove',
    'common.delete':       'Delete',
    'common.reset':        'Reset',
    'common.all':          'All',
    'common.vs':           'vs',
    'common.player1':      'Player 1',
    'common.player2':      'Player 2',
    'common.buildFirst':   'Build the tournament first.',
    'common.dash':         '—',

    'common.nav.aria':          'Main navigation',
    'common.nav.register':      'Register',
    'common.nav.participants':  'Participants',
    'common.nav.registrations': 'Registrations',
    'common.nav.build':         'Build',
    'common.nav.standings':     'Standings',
    'common.nav.schedule':      'Schedule',
    'common.nav.bracket':       'Bracket',
    'common.nav.settings':      'Settings',

    'lang.aria': 'Language',
    'lang.he':   'עב',
    'lang.en':   'EN',

    'admin.btn':            'Admin',
    'admin.btnAdminOn':     'Admin ✓',
    'admin.btnMasterOn':    'Master ✓',
    'admin.modeHint':       'Tap Admin to manage',
    'admin.modeView':       'View only — tap Admin to manage',
    'admin.modeMasterReg':  'Master mode — full access',
    'admin.modeAdminReg':   'Admin mode — approvals and adding pairs',
    'admin.modeMasterBuilt':'Master mode — tournament built',
    'admin.modeAdminBuilt': 'Admin mode — edit pairs',
    'admin.modeScores':     'Admin mode — score entry',
    'admin.loginTitle':     'Sign in',
    'admin.roleAdmin':      'Admin',
    'admin.roleMaster':     'Master',
    'admin.pwPh':           'Password',
    'admin.pwWrong':        'Incorrect password.',
    'admin.loginBtn':       'Sign in',
    'admin.regsTitle':      'Registrations',
    'admin.filterAll':      'All',
    'admin.filterPending':  'Pending',
    'admin.filterApproved': 'Approved',
    'admin.filterRejected': 'Rejected',
    'admin.status.pending': 'Pending',
    'admin.status.approved':'Approved',
    'admin.status.rejected':'Rejected',
    'admin.noRegs':         'No registrations',
    'admin.approve':        'Approve',
    'admin.undo':           'Undo',
    'admin.delete':         'Delete',
    'admin.deleteTitle':    'Remove permanently',
    'admin.confirmDelete':  'Permanently delete this registration? You can reject it instead.',
    'admin.noPhone':        '—',

    'reg.title':        'Register',
    'reg.subtitle':     'Register for {name}',
    'reg.closed':       'Registration is currently closed.',
    'reg.p1Label':      'Player 1 name',
    'reg.p2Label':      'Player 2 name',
    'reg.namePh':       'Full name',
    'reg.phoneLabel':   'Phone',
    'reg.catLabel':     'Category',
    'reg.ok':           'Registration sent! We will let you know once it is approved.',
    'reg.submit':       'Send registration',
    'reg.payment':      'Payment',
    'reg.payLink':      'Pay now',
    'reg.payLink2':     'Pay now (2)',

    'parts.title':    'Registered pairs',
    'parts.subtitle': 'Approved registrations',
    'parts.hidden':   'The participant list is not public yet.',
    'parts.empty':    'No approved pairs yet',

    'build.title':          'Build tournament',
    'build.subtitle':       'Drag the pairs into order, then build the tournament.',
    'build.builtBanner':    '✓ Tournament built — you can still edit pairs and rebuild',
    'build.pairsCount':     '{n} pairs',
    'build.pairsCount_one': '1 pair',
    'build.build':          '▶ Build tournament',
    'build.rebuild':        '↺ Rebuild',
    'build.shuffle':        'Shuffle',
    'build.addPair':        '+ Add pair',
    'build.moveUp':         'Move up',
    'build.moveDown':       'Move down',
    'build.startNoteBuilt': 'The tournament is built and ready. Press "Start tournament" when play begins.<br>Settings can no longer be changed after that.',
    'build.startNoteReg':   'Build every category first, then start the tournament.',
    'build.start':          '▶ Start tournament',
    'build.startQ':         'Start the tournament?',
    'build.startBody':      'Best done right as play begins. Once started, pairs and settings can no longer be changed.',
    'build.editPair':       'Edit pair',
    'build.addPairTitle':   'Add a pair directly',
    'build.confirmRemove':  'Remove "{name}" from the tournament?',
    'build.confirmRemoveAnon': 'Remove this pair?',

    'stand.title':        'Standings',
    'stand.group':        'Group {name}',
    'stand.col.team':     'Team',
    'stand.col.w':        'W',
    'stand.col.l':        'L',
    'stand.col.diff':     '+/−',
    'stand.col.pts':      'Pts',
    'stand.emptyH':       'No tournament data yet',
    'stand.editTitle':    'Edit — Group {name}',
    'stand.editAria':     'Edit pair',
    'stand.removeAria':   'Remove pair',
    'stand.confirmRemove':'Remove "{name}" from group {group}?',

    'sched.searchPh':    'Search pair…',
    'sched.searchAria':  'Search the schedule for a pair',
    'sched.statPool':    'Pool games played',
    'sched.statKO':      'Knockout games',
    'sched.statEnd':     'Scheduled end',
    'sched.court':       'Court {n}',
    'sched.courtShort':  'C{n}',
    'sched.vs':          'vs',
    'sched.emptyH':      'No schedule yet',
    'sched.noGames':     'No games',
    'sched.noMatch':     'No match for "{q}"',
    'sched.pools':       'Pools',
    'sched.third':       '3rd place',
    'sched.subLabel':    '{cat} — {stage}',
    'sched.rule':        ' (to {pts})',
    'sched.ruleSwitch':  ' (to {pts}, switch every {change})',
    'sched.breakDefault':'Break',
    'sched.breakLine':   '{note} — {min} min break · {from}–{to} · all courts',
    'sched.scoreA':      'First side score',
    'sched.scoreB':      'Second side score',

    'bracket.title':        'Knockout bracket',
    'bracket.noPool':       'No pool stage scheduled yet.',
    'bracket.poolInfo':     'Pools: {progress} — the bracket updates live',
    'bracket.poolPlayed':   '{done}/{total} played',
    'bracket.round.final':  'Final',
    'bracket.round.sf':     'Semifinals',
    'bracket.round.qf':     'Quarterfinals',
    'bracket.round.r16':    'Round of 16',
    'bracket.round.of':     'Round of {n}',
    'bracket.lbl.final':    'Final',
    'bracket.lbl.sf':       'SF{n}',
    'bracket.lbl.qf':       'QF{n}',
    'bracket.lbl.r16':      'R16-{n}',
    'bracket.lbl.game':     'G{n}',
    'bracket.third':        '3rd place',
    'bracket.champion':     'Champions',
    'bracket.direct':       'Direct',
    'bracket.tbd':          'TBD',
    'bracket.bye':          'Bye',
    'bracket.loserSf':      'Loser of SF{n}',
    'bracket.winnerOf':     'Winner of {round} {n}',

    'score.nonNegative':     'Scores must be 0 or higher',
    'score.setsFormat':      'Sets won: 2:0 or 2:1',
    'score.setsWinner':      'The winner needs 2 sets',
    'score.noDraw':          'Scores can’t be equal',
    'score.mustReach':       'Must reach {n}',
    'score.mustReachEg':     'Must reach {n} · e.g. {n}–{lo}',
    'score.needLead':        'Needs a {n}-point lead',
    'score.exactlyTwoAbove': 'Above {n}: exactly 2 apart',

    'settings.title':          'Settings',
    'settings.design':         'Design',
    'settings.name':           'Tournament name',
    'settings.namePh':         'Tournament name',
    'settings.primary':        'Primary colour',
    'settings.primaryDesc':    'Main accent — headers, buttons',
    'settings.secondary':      'Secondary colour',
    'settings.secondaryDesc':  'Gradients and accent buttons',
    'settings.preview':        'Preview',
    'settings.bg':             'Background colour',
    'settings.bgDesc':         'Overrides the site background',
    'settings.logo':           'Logo',
    'settings.logoUrl':        'Logo URL',
    'settings.logoDesc':       'Tournament logo image',
    'settings.groupColors':    'Group colours',
    'settings.sponsors':       'Sponsors',
    'settings.sponsorUrlPh':   'Image URL…',
    'settings.sponsorNamePh':  'Name…',
    'settings.noSponsors':     'No sponsors yet — add one below.',
    'settings.addSponsor':     '+ Add sponsor',
    'settings.players':        'Player database',
    'settings.playerNamePh':   'Player name…',
    'settings.playerPhonePh':  'Phone (optional)',
    'settings.importPlayers':  '↓ Import every player from this tournament',
    'settings.playersCount':   '{n} players',
    'settings.playersCount_one':'1 player',
    'settings.noPlayers':      'No players yet — import them, or add pairs through the dialog.',
    'settings.imported':       'Imported {n} new players.',
    'settings.imported_one':   'Imported 1 new player.',
    'settings.allImported':    'Every player is already in the database.',
    'settings.groups':         'Groups',
    'settings.groupLabel':     'Group',
    'settings.teamsCount':     '{n} pairs',
    'settings.teamsCount_one': '1 pair',
    'settings.moveTo':         'Move to…',
    'settings.moveToGroup':    'Group {name}',
    'settings.sport':          'Sport',
    'settings.sportDesc':      'Volleyball hides the per-stage "(to 21, switch every 7)" note — games always go to 21. Footvolley shows the custom points set for each stage.',
    'settings.sportFootvolley':'Footvolley / custom',
    'settings.sportVolleyball':'Beach volleyball (to 21)',
    'settings.registration':   'Registration',
    'settings.regOpen':        'Registration open',
    'settings.showList':       'Show the participant list publicly',
    'settings.regNote':        'Registration note',
    'settings.regNoteDesc':    'Shown above the registration form.',
    'settings.regNotePh':      'e.g. Payment is due by Friday…',
    'settings.payLinks':       'Payment links',
    'settings.payLinksDesc':   'Shown in the registration form.',
    'settings.labelPh':        'Label…',
    'settings.urlOptionalPh':  'https://… (optional)',
    'settings.categories':     'Categories',
    'settings.addCategory':    'Add category',
    'settings.addCategoryDesc':'Create a new category for this tournament',
    'settings.newCategory':    'New category',
    'settings.deleteCategory': 'Delete category',
    'settings.confirmDeleteCat':'Delete this category?',
    'settings.cantDeleteCat':  'Categories cannot be deleted while a tournament is running.',
    'settings.start':          'Start tournament',
    'settings.startNote':      'When every pair is ready, start the tournament.<br>Pairs and settings cannot be changed after that.',
    'settings.confirmResetScores': 'Reset ALL scores?',
    'settings.courts':         'Courts',
    'settings.numGroups':      'Groups',
    'settings.advPerGroup':    'Advance per group',
    'settings.gameDur':        'Game minutes',
    'settings.breakDur':       'Break minutes',
    'settings.sets':           'Sets',
    'settings.thirdSetPts':    '3rd set points',
    'settings.startTime':      'Start time',
    'settings.scoringRules':   'Scoring rules',
    'settings.rules.stage':    'Stage',
    'settings.rules.pts':      'Points to win',
    'settings.rules.switch':   'Switch every',
    'settings.rules.min':      'Min',
    'settings.stage.pool':     'Pools',
    'settings.stage.r16':      'Round of 16',
    'settings.stage.qf':       'Quarterfinal',
    'settings.stage.sf':       'Semifinal',
    'settings.stage.third':    '3rd place',
    'settings.stage.final':    'Final',

    'errors.p1Required':   'Player 1 name is required.',
    'errors.catRequired':  'Please choose a category.',
    'errors.submitFailed': 'Sending failed. Please try again.',
    'errors.statusUpdate': 'Could not update the status. Please try again.',
    'errors.noApproved':   'No approved pairs in this category.',
    'errors.groupMin':     'A group needs at least one pair.',

    // ── wave 2: receipt, not-found, registration tools, uploader ──
    'common.notFoundH':        'Tournament not found',
    'common.notFoundP':        'We couldn’t find this tournament. Please check the link you received, or ask the organizer to send it again.',
    'reg.soon':                'Registration opens soon.',
    'reg.sending':             'Sending…',
    'reg.mine':                'Your registrations from this browser:',
    'reg.cancelContact':       'To cancel, contact the organizer.',
    'reg.confirmCancel':       'Cancel your registration?',
    'reg.receiptTitle':        'Registration received ✓',
    'reg.receiptPair':         'Pair',
    'reg.receiptStatus':       'Status',
    'reg.pendingApproval':     'Pending approval',
    'reg.payNote':             'Please write your names in the payment note.',
    'reg.another':             'Register another pair',
    'admin.paid':              'Paid',
    'admin.filterPaidAll':     'Paid + unpaid',
    'admin.filterPaid':        'Paid',
    'admin.filterUnpaid':      'Unpaid',
    'admin.searchPh':          'Search name or phone…',
    'admin.searchAria':        'Search registrations',
    'admin.exportCsv':         'Export CSV',
    'settings.info':           'Tournament info',
    'settings.infoDesc':       'Optional. Shown at the top of Register and Schedule.',
    'settings.eventDate':      'Event date',
    'settings.venue':          'Venue',
    'settings.venuePh':        'Venue, e.g. Gordon Beach',
    'settings.price':          'Price',
    'settings.pricePh':        'Price, e.g. ₪150 per pair',
    'settings.lang':           'Default language',
    'settings.langDesc':       'Viewers can switch language in the header.',
    'settings.logoUploadDesc': 'Upload an image (PNG/JPG/WebP — resized automatically) or paste an image URL.',
    'settings.logoDropAria':   'Upload logo: click, drop or paste an image',
    'settings.logoDropHint':   'Drop logo here, click to choose, or paste',
    'settings.logoCurrent':    'Current logo',
    'settings.removeLogo':     'Remove logo',
    'settings.uploadedPh':     'Uploaded image — paste a URL to replace',
    'settings.upload':         'Upload',
    'errors.nameRequired':     '{who} name is required.',
    'errors.nameTooLong':      '{who} name is too long (max {max} characters).',
    'errors.nameSlash':        '{who} name can’t contain "/".',
    'errors.sameNames':        'Player 1 and Player 2 must be different people.',
    'errors.phoneRequired':    'Phone number is required.',
    'errors.phoneInvalid':     'Please enter a valid mobile number: 05X-XXXXXXX, or an international number starting with +.',
    'errors.dupPair':          'This pair is already registered in this category (status: {status}).',
    'errors.dupPhone':         'This phone number is already registered in this category (status: {status}).',
    'errors.cancelFailed':     'Could not cancel. Please try again.',
    'errors.paidUpdate':       'Could not update payment status.',
    'errors.uploadFailed':     'Upload failed.',
    'errors.metaFull':         'Not enough room for this image. Remove a sponsor or logo, or use an image URL instead.',
    'upload.notImage':         'Please choose an image file (PNG, JPG or WebP).',
    'upload.svg':              'SVG files are not supported — please use PNG, JPG or WebP.',
    'upload.decode':           'Couldn’t read this image. Try saving it as PNG or JPG.',
    'upload.tooBig':           'Couldn’t make this image small enough. Try a simpler or smaller image.',
    'upload.huge':             'This file is too large (max 15 MB).',
    'admin.modeMasterScores':  'Master mode — score entry',
    'csv.status':              'Status',
    'csv.created':             'Registered at',
    'csv.yes':                 'Yes',
    'csv.no':                  'No',
    'common.back':             'Back',
    'admin.reject':            'Reject',
    'reg.cancelReg':           'Cancel registration',
    'reg.cancelled':           'Registration cancelled',
    'sched.scoreFor':          'Score for {team}',
    'score.bothSides':         'Enter both scores',

    'terms.pair':    'pair',
    'terms.pairs':   'pairs',
    'terms.team':    'team',
    'terms.teams':   'teams',
    'terms.player':  'player',
    'terms.players': 'players',
    'terms.group':   'group',
    'terms.groups':  'groups',
    'terms.court':   'court',
    'terms.courts':  'courts',
    'terms.set':     'set',
    'terms.sets':    'sets'
  }
};

// Read-only view for tooling (key-parity checks); not for runtime lookups.
export const DICTS = DICT;
