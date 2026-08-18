// ============================================================================
// league.js — ליגת קיץ פוצ׳ילינה 2026
//
// מודל הנתונים + סנכרון חי (שלב 1), רוסטר והגדרות (2), עמוד המתזמן (3),
// ניקוד ודירוג (4), ומשלב 6: שלוש רמות הרשאה (§7.1), טיוטה/פרסום לכל יום
// ולטאב הפיינל פור (§8.5), הלוז הציבורי, עמוד הקבוצות המלא ופאנל הנוכחות
// והזמינות (§8.4). שלב 6ב מוסיף את דחיסת הלוז החיה (§8.7).
// המתזמן, לוח הגרירה והפיינל פור יושבים במודולים נפרדים.
//
// המסמך היחיד: tournaments/{LEAGUE_ID}. ראו §5.1 במפרט.
// ============================================================================

import {
  db, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  escH, sha256, applyTheme, onColor, focusSnapshot, focusRestore
} from './common.js?v=2';

// שלוש השפות של העמודים הציבוריים. ראו league-i18n.js — כולל ההחלטה
// שהכיוון נשאר RTL בכל שפה, כי שמות הקבוצות נשארים עברית.
import { t, tData, getLang, setLang, LANGS } from './league-i18n.js?v=4';

// המתזמן — שלב 3. מודול טהור: הוא לא מכיר את L, את ה-DOM או את Firestore,
// והוא מקבל תמונת מצב ומחזיר משחקים ודוח. ראו league-sched.js.
import {
  generateSeason, buildDayContext, dayCost, dayLength, slotLabel
} from './league-sched.js?v=9';

// לוח הגרירה — שלב 5. מודול תצוגה+שליטה שמקבל את המצב החי דרך Board.init().
// אין לו window.* globals; פעולותיו בקידומת board.* ומוזרקות ל-ACT (ראו start()).
import Board from './league-board.js?v=11';
import KO from './league-ko.js?v=4';

// ============ זהות הליגה ============
// ⚠️ המזהה הזה מופיע בכתובת הציבורית שכל 72 השחקניות מקבלות. הוא לא זמני.
// הפרמטר הוא ?l= ולא ?t= — ?t= שייך לאפליקציית הטורנירים, וערבוב בין השניים
// היה שולח מישהי לעמוד הלא נכון. ?l=futilina-test מאפשר לבדוק בלי לגעת בדוק
// האמיתי (מלכודת 6: בדיקות באפליקציה החיה כותבות ל-Firestore האמיתי).
const params    = new URLSearchParams(location.search);
const LEAGUE_ID = params.get('l') || 'futilina-2026';
const DEV       = params.get('dev') === '1';
const INIT      = params.get('init') === '1';   // יצירת דוק חדש — ראו loadLeague()
// ?m=1 — כניסת המנהלת. הקישור הציבורי שמקבלות 72 השחקניות לא נושא את
// הפרמטר, ולכן הן רואות ניווט של צופה בלבד: הכפתור "כניסת מנהלת" פשוט אינו
// שם. זו לא שכבת אבטחה (SECURITY.md — ההרשאה נאכפת בדפדפן ממילא), אלא
// הסרת פקד שאינו שייך לאף אחת מהן. המנהלת שומרת את הקישור עם ‎?m=1‎.
const MGR       = params.get('m') === '1';

// ============================================================================
// מודל הנתונים — §5.1
// ============================================================================

// פלטת המותג של פוצ׳ילינה — קודי Pantone שהתקבלו 24.7.2026 (§15.1 שוחרר).
// חמישה צבעים; לבן הוא רקע הדף (--bg2 ב-styles.css), ולכן ארבעת הצבעים
// שאינם לבן הם ארבע הרשתות (החלטה 1). המגנטה משמשת גם כמסך הטעינה הוורוד
// (החלטה 14, Pantone 807 C) וגם כצבע הראשי של המותג.
//
// ⚠️ אלה נתונים, לא קוד: הם נכתבים למסמך דרך defaultDoc וניתנים לשינוי
// בעמוד ההגדרות. מסמך קיים שומר את הצבעים שכבר נכתבו לו (mergeDefaults
// מעדיף את המסמך), ולכן החלפה במסמך חי עוברת דרך ההגדרות, לא דרך הקוד.
const NET_COLORS = ['#EE2BC1', '#DAFF00', '#0775ED', '#000B19'];   // 807C · 809C · 2173C · כהה
// שמות לפי מספר מגרש (החלטת המשתמשת) — הצבע הוא הזיהוי הוויזואלי, המספר הוא השם.
const NET_NAMES  = ['מגרש 1', 'מגרש 2', 'מגרש 3', 'מגרש 4'];
const BRAND_PINK      = '#EE2BC1';   // מסך טעינה — החלטה 14 (Pantone 807 C)
const BRAND_PRIMARY   = '#EE2BC1';   // הצבע המוביל של פוצ׳ילינה
const BRAND_SECONDARY = '#0775ED';   // Pantone 2173 C

const BEACH = 'חוף בוגרשוב, תל אביב';

// פורמטים — §2.6 והטבלה המסכמת שם.
// by:2 = הארכה עד הפרש 2. cap = תקרה קשה. cap:null = ללא תקרה (החלטה 18).
const F_SET18   = { sets:1, to:18, by:2, cap:25 };            // 3.5
const F_BO3     = { sets:3, to:18, third:15, by:2, cap:25 };  // 3.9.4 / 3.9.6
const F_SET21   = { sets:1, to:21, by:2, cap:null };          // 3.9.5 + החלטה 18

const clone = o => JSON.parse(JSON.stringify(o));

function defaultDays() {
  const base = { beach:BEACH, startTime:'17:00', slotMin:20, slots:16,
                 netIds:[1,2,3,4], published:false };
  return [
    { id:'r1',    label:'מחזור 1',       date:'2026-08-22', ...clone(base) },
    { id:'r2',    label:'מחזור 2',       date:'2026-08-29', ...clone(base) },
    { id:'r3',    label:'מחזור 3',       date:'2026-09-05', ...clone(base) },
    { id:'r4',    label:'מחזור 4',       date:'2026-09-12', ...clone(base) },
    { id:'ff',    label:'פיינל פור',     date:'2026-09-19', ...clone(base) },
    // 3.11.6 — מועד מיוחד אחרי הפיינל פור, טרם נקבע.
    { id:'cross', label:'משחקי הצלבה',  date:null,         ...clone(base) },
  ];
}

function defaultDoc() {
  return {
    meta: {
      mode: 'league',                 // כך admin.html ממשיך להציג את הליגה ברשימה
      name: 'ליגת קיץ פוצ׳ילינה 2026',
      logoUrl: '',
      primaryColor:   BRAND_PRIMARY,
      secondaryColor: BRAND_SECONDARY,
      loadingColor:   BRAND_PINK,             // החלטה 14
      font: 'Rubik',                          // מלכודת 4: Barlow לטיני בלבד
      sponsorLogos: [],

      // אין Firebase Auth — ההרשאות נאכפות בדפדפן בלבד. ראו SECURITY.md
      // ומלכודת 7: לא לשמור טלפונים בדוק הזה.
      adminPasswordHash: '',
      managerPasswordHash: '',

      nets: NET_COLORS.map((color, i) => ({
        id: i + 1, name: NET_NAMES[i], color
      })),

      days: defaultDays(),

      tieBreak: ['pts','diff','h2h'],   // 3.10 — נעול, לא ניתן לשינוי

      // §8.7 — דחיסת לוז חיה (שלב 6ב). כבוי = הלוז יציב לגמרי ואין הצעות.
      // זהו השדה **היחיד** שנוסף ל-§5 (מאושר במפורש ב-§8.7).
      liveReschedule: false,

      // ניקוד — סעיף 3.7 והמקרים יוצאי הדופן בסעיף 6.
      // ⚠️ unfinished הוא 1.5 (6.2). זהו הערך היחיד שאינו שלם, והוא הסיבה
      // שכל חישוב הנקודות חייב להיות עשרוני. ראו §10.2 במפרט.
      scoring: {
        win: 2,            // 3.7.1
        loss: 1,           // 3.7.2
        techLoss: 0,       // 3.7.3
        unfinished: 1.5,   // 6.2 — לשתי הקבוצות, הפרש 0
        walkoverFor: 18,   // 6.3.1 / 6.3.2 / 6.1.2
        walkoverAgainst: 10
      }
    },

    categories: [
      { id:'show',  name:'ליגת שואו',    rr:2, order:1, fixedNet:1 },  // החלטות 4,5
      { id:'liga1', name:'ליגה ראשונה', rr:1, order:2 },               // 3.4
      // allowConsecutive: רק ליגה ב׳ מתירה רצף נדיר (החלטת המשתמשת 25.7) —
      // נותן למתזמן מוצא במקום המתנות ארוכות; שואו וליגה א׳ נשארות אפס רצף.
      { id:'liga2', name:'ליגה שנייה',  rr:1, order:3, allowConsecutive:true }
    ],

    formats: {
      show:  { regular:clone(F_SET18), sf:clone(F_BO3),   third:clone(F_SET18), final:clone(F_BO3) }, // החלטה 6
      liga1: { regular:clone(F_SET18), sf:clone(F_BO3),   third:clone(F_SET18), final:clone(F_BO3) },
      liga2: { regular:clone(F_SET18), sf:clone(F_SET21), third:clone(F_SET18), final:clone(F_BO3) }
    },

    // מרשם השחקניות — §5.4. מקור אמת אחד לשם: { p001:{name:'רוני כהן'} }.
    // team.players מחזיק מזהים ולא שמות, ולכן שחקנית שמשחקת בשאו וגם בליגה
    // היא אותה רשומה בשתי הקבוצות.
    players: {},

    // קבוצה = רשומה עם id (החלטה 7). השם הוא מחרוזת אחת (החלטה 8).
    // רשימת הקבוצות מתפרסמת אחרי 12.8.2026 — §15.4.
    roster: { show:[], liga1:[], liga2:[] },

    availability: {},   // { r1: { l1t03:{notBefore,notAfter,note} } } — אילוץ קשיח למתזמן
    attendance:   {},   // { r1: { l1t03:'ok'|'noshow' } } — מה שקרה בפועל
    games:        [],   // ראו newGame()
    blocks:       [],   // { id, day, slot, net, kind:'liga3'|'break'|'ceremony', label }

    ko: {
      show:  { sfSlotChoice:null, sf:[], third:null, final:null, substitutions:[] },
      liga1: { sfSlotChoice:null, sf:[], third:null, final:null, substitutions:[] },
      liga2: { sfSlotChoice:null, sf:[], third:null, final:null, substitutions:[] }
    },

    crossover: []   // 3.11.3 / 3.11.4 — שני משחקים
  };
}

// תבנית משחק. ⚠️ sets הוא מערך של אובייקטים ולא מערך של מערכים:
// Firestore אוסר מערך בתוך מערך, כך ש-[[18,16]] היה נכשל בכתיבה.
function newGame(id, cat, day) {
  return {
    id, cat, day,
    slot: null, net: null,
    a: null, b: null,          // מזהי קבוצות, לא שמות
    sa: null, sb: null,
    sets: [],                  // [{a:18,b:16}] — רק "הטוב מ-3"
    result: 'pending',         // ok | tech_a | tech_b | both_absent | unfinished | cancelled
    locked: false
  };
}

// ============================================================================
// מזהי שחקניות — §5.4
// ============================================================================
//
// כל שחקנית מקבלת מזהה אחד (p001) במרשם L.players, ו-team.players מחזיק מזהים
// ולא שמות. לכן שחקנית שמשחקת בשאו וגם בליגה היא **אותה רשומה** בשתי הקבוצות,
// והמתזמן יכול לדעת ששתי הקבוצות שלה אינן יכולות לשחק באותו סלוט.
// המזהים אינם ממוחזרים, בדיוק כמו מזהי קבוצות (החלטה 7): מרשם הטלפונים בדוק
// הפרטי מוצמד למזהה, ומיחזור היה מדביק את הטלפון של אחת לאחרת.

const isPid = v => typeof v === 'string' && /^p\d+$/.test(v);

// השוואת שמות להשלמה האוטומטית: רווח כפול ואותיות גדולות/קטנות (שם לטיני)
// אינם הבדל. מעבר לזה לא מנרמלים — "נועה" ו"נועה כהן" הן שתי שחקניות שונות.
const normName = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// שם לתצוגה מערך של סלוט. מזהה → מהמרשם; מחרוזת → כמות שהיא. המקרה השני הוא
// תאימות לאחור: קבוצות שנשמרו לפני §5.4 מחזיקות שמות בתוך players.
function slotName(v, reg) {
  if (isPid(v)) return (reg || L.players || {})[v]?.name || '';
  return v || '';
}

function nextPlayerId() {
  const used = Object.keys(L.players || {})
    .map(k => parseInt(k.slice(1), 10)).filter(Number.isFinite);
  return 'p' + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
}

function newPlayer(name) {
  const id = nextPlayerId();
  (L.players ||= {})[id] = { name };
  return id;
}

// מזהה שחקנית → כל הקבוצות שהיא רשומה בהן. הבסיס גם לסימון ⇄ ברוסטר וגם
// לזוגות הקשורים שהמתזמן מקבל (links ב-schedInput).
function playerTeams() {
  const map = {};
  for (const [cat, list] of Object.entries(L.roster || {}))
    for (const t of (list || []))
      for (const v of new Set(teamSlots(t)))
        if (isPid(v)) (map[v] ||= []).push({ cat, team: t });
  return map;
}

// זוגות קבוצות שחולקות שחקנית (§5.4). המתזמן כבר מכיר את השדה `links` ומעניש
// עליו שיבוץ צפוף (linkedOverlap); הפיכתו לאילוץ קשיח היא שלב 3 של §5.4
// ונעשית ב-league-sched.js.
function sharedTeamPairs() {
  const pairs = new Set();
  for (const list of Object.values(playerTeams()))
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].team.id, b = list[j].team.id;
        if (a !== b) pairs.add(a < b ? a + '|' + b : b + '|' + a);
      }
  return [...pairs].map(k => k.split('|'));
}

// שם הקבוצה נגזר תמיד מהמרשם (החלטה 8 + §5.4). מורץ גם על מסמך נכנס, כך
// ששינוי שם שחקנית בחלון אחר מחלחל לשמות הקבוצות בכל מקום בלי כתיבה נוספת.
function syncTeamNames(d) {
  const reg = d.players || {};
  for (const list of Object.values(d.roster || {}))
    for (const t of (list || [])) {
      const names = teamSlots(t).filter(Boolean).map(v => slotName(v, reg));
      // מזהה שאין לו רשומה במרשם = מסמך חלקי (למשל לשונית שעדיין מריצה גרסה
      // ישנה של league.js ושמרה בלי players). לא מוחקים אז את שמות הקבוצות —
      // משאירים את השם האחרון שהיה במסמך עד שהמרשם חוזר.
      if (names.some(n => !n)) continue;
      t.name = names.join(' · ');
    }
}

// ההכרעה של §5.4: מה קורה כשמקלידים שם במשבצת שחקנית. מחזיר מזהה לשיבוץ,
// או '' לניקוי המשבצת.
//
//   שם שכבר במרשם  → מציע לשייך את אותו מזהה (**הרגע היחיד** שבו נקבע ששתי
//                     קבוצות חולקות שחקנית). אישור = משותפת, ביטול = חדשה.
//   שם חדש         → אם בסלוט יושבת שחקנית ששייכת רק לקבוצה הזאת, זה תיקון
//                     שם והמזהה נשמר (אחרת כל תיקון הקלדה היה שובר את השיוך).
//                     אם היא משותפת — שואלים אם לשנות את שמה בכל מקום.
//   שם כפול במרשם  → לא מנחשים: נוצרת חדשה, עם הסבר.
function resolveSlot(typed, cur, catId, teamId) {
  if (!typed) return '';
  const curPid = (isPid(cur) && L.players?.[cur]) ? cur : null;
  if (curPid && normName(slotName(curPid)) === normName(typed)) return curPid;

  const usage = playerTeams();
  const others = pid => (usage[pid] || []).filter(x => x.team.id !== teamId);
  const where  = list => list.map(x => `״${x.team.name || x.team.id}״ (${CAT_NAME(x.cat)})`).join(', ');

  const matches = Object.entries(L.players || {})
    .filter(([id, p]) => id !== curPid && normName(p.name) === normName(typed))
    .map(([id]) => id);

  if (matches.length > 1) {
    alert(`יש כבר יותר משחקנית אחת בשם "${typed}", ואי אפשר לדעת למי התכוונת. ` +
          `נרשמה שחקנית חדשה. כדי לשייך אותה לשחקנית קיימת — כדאי להוסיף שם משפחה ולהבדיל ביניהן.`);
    return newPlayer(typed);
  }

  if (matches.length === 1) {
    const pid = matches[0], rest = others(pid);
    // כבר בקבוצה הזאת, במשבצת אחרת — המשבצת הכפולה מתרוקנת ולא נוצרת כפילות.
    const self = findTeam(teamId)?.team;
    if (self && teamSlots(self).includes(pid)) {
      alert(`"${typed}" כבר רשומה בקבוצה הזאת.`);
      return '';
    }
    // שחקנית לא יכולה לשחק בשתי קבוצות באותה ליגה — רק שאו + ליגה אחת (§5.4).
    const clash = rest.find(x => x.cat === catId);
    if (clash) {
      alert(`"${typed}" כבר רשומה ב״${clash.team.name || clash.team.id}״ באותה ליגה. ` +
            `שחקנית לא יכולה לשחק בשתי קבוצות באותה ליגה, ולכן נרשמה שחקנית חדשה בשם הזה.`);
      return newPlayer(typed);
    }
    if (!rest.length) return pid;   // קיימת במרשם אך אינה משובצת — פשוט חוזרת
    if (confirm(`"${typed}" כבר משחקת ב-${where(rest)}. זו אותה שחקנית?\n\n` +
                `אישור — אותה שחקנית בשתי הקבוצות.\nביטול — שחקנית אחרת עם אותו שם.`))
      return pid;
    return newPlayer(typed);
  }

  if (curPid) {
    const rest = others(curPid);
    if (!rest.length) { L.players[curPid].name = typed; return curPid; }   // תיקון שם
    if (confirm(`"${slotName(curPid)}" משחקת גם ב-${where(rest)}.\n\n` +
                `אישור — שינוי שמה ל"${typed}" בכל מקום.\nביטול — שיבוץ שחקנית אחרת כאן בלבד.`)) {
      L.players[curPid].name = typed;
      return curPid;
    }
  }
  return newPlayer(typed);
}

// ============================================================================
// קבוצות
// ============================================================================

// קידומת לכל ליגה, כדי שמזהה קבוצה יקרא גם בעין: l1t03 = ליגה ראשונה, קבוצה 3.
const CAT_PREFIX = { show:'s', liga1:'l1', liga2:'l2' };

// מזהים לא ממוחזרים לעולם. קבוצה שנמחקה משאירה את המספר שלה מת, כי משחקים,
// בקשות זמינות ונוכחות מצביעים על המזהה (החלטה 7) ומיחזור היה מדביק היסטוריה
// של קבוצה אחת לקבוצה אחרת.
function nextTeamId(catId) {
  const prefix = CAT_PREFIX[catId] || catId;
  const used = (L.roster[catId] || [])
    .map(t => parseInt(String(t.id).slice(prefix.length + 1), 10))
    .filter(n => Number.isFinite(n));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}t${String(n).padStart(2, '0')}`;
}

// שלושה שדות שם, לא בורר גודל (החלטת המשתמשת 24.7): ממלאים 2 → זוג, 3 →
// שלישייה, והמערכת מסיקה. זה גם מתיישר עם טופס ההרשמה החיצוני שאוסף שחקניות
// בנפרד. `players` מחזיק **מזהי שחקניות** (§5.4) ו-`name` נגזר מהמרשם ומוצג
// כיחידה אחת (החלטה 8 נשמרת בתצוגה). `size` נגזר, לא נשמר.
function newTeam(catId) {
  return {
    id: nextTeamId(catId),
    players: ['', '', ''],   // עד 3 (2.1); מספר המלאים קובע זוג/שלישייה
    name: '',                // = players.map(שם מהמרשם).filter(Boolean).join(' ')
    // active/withdrewAfterDay נשארים במודל לטובת 6.1 בשלב 4 (הזנת תוצאות),
    // בלי פקד ברוסטר: פרישה נדירה, ומטופלת במחיקה או בסימון "טכני" למשחק (§10.3).
    active: true,
    withdrewAfterDay: null
  };
}

// שלושת הסלוטים כמות שהם: מזהי שחקניות (§5.4), או — בקבוצות שנשמרו לפני
// השינוי — שמות כמחרוזות. תומך גם בקבוצה ישנה שנשמרה עם name בלבד.
// זוג/שלישייה נגזר ממספר הסלוטים המלאים ולא נשמר בנפרד.
function teamSlots(t) {
  if (Array.isArray(t.players)) return [t.players[0] || '', t.players[1] || '', t.players[2] || ''];
  return [t.name || '', '', ''];
}

// כל הקבוצות בכל הליגות, לחיפוש לפי מזהה
function findTeam(id) {
  for (const [cat, list] of Object.entries(L.roster)) {
    const t = list.find(x => x.id === id);
    if (t) return { team: t, cat };
  }
  return null;
}

const findGame  = id => (L.games || []).find(g => g.id === id);
const dayLabel  = id => (L.meta.days || []).find(d => d.id === id)?.label || id;

// ============================================================================
// ניקוד ודירוג — §10 (הליבה של שלב 4). פונקציות טהורות: קוראות מ-L ומחזירות
// מספרים, בלי DOM. שלב 5 (טאב "לוז") יקרא לאותן פונקציות — ה-UI זמני, זה נשאר.
// ============================================================================
//
// מוסכמת result (המודל ב-§5.1 נעול, ולכן הסיווג טכני/היעדרות נגזר מ-attendance
// ולא משדה חדש, החלטת המשתמשת):
//   pending      — לא שוחק. לא נספר.
//   ok           — sa/sb אמיתיים. מנצחת win, מפסידה loss. הפרש = sa−sb.
//   tech_a/tech_b— האות היא הצד ה*מפסיד* (A או B קיבל הפסד טכני). היריבה win + 18:10.
//   both_absent  — 0:0, שתיהן techLoss, שתיהן היעדרות.
//   unfinished   — כוח עליון (6.2): שתיהן unfinished(=1.5), הפרש 0.
//   cancelled    — 6.1.1: לא נספר כלל.
// פציעה (6.3.2 = מנצחת 2 / פצועה 1 / 18:10) נרשמת כ-ok עם 18:10 — אין לה value ייעודי.

// §10.1 — מערכה עד `to`, הפרש 2, תקרה `cap`. cap=null → כלל ה-21 ללא תקרה (החלטה 18).
function validSet(win, lose, to, cap) {
  if (!(win > lose) || lose < 0 || win < 0) return false;
  if (cap == null) return (win === to && lose <= to - 2) || (win > to && win - lose === 2);
  return (win === to && lose <= to - 2)
      || (win > to && win < cap && win - lose === 2)
      || (win === cap && lose >= cap - 2);
}

// הניקוד להצגה: תוצאה טכנית/כוח-עליון גוזרת ניקוד קבוע; אחרת מה שהוזן.
function techScores(g) {
  const sc = L.meta.scoring || {};
  const wf = sc.walkoverFor ?? 18, wa = sc.walkoverAgainst ?? 10;
  if (g.result === 'tech_a')      return { sa: wa,   sb: wf   };
  if (g.result === 'tech_b')      return { sa: wf,   sb: wa   };
  if (g.result === 'both_absent') return { sa: 0,    sb: 0    };
  if (g.result === 'unfinished')  return { sa: null, sb: null };
  return { sa: g.sa, sb: g.sb };
}

// האם ההפסד הטכני של הצד המפסיד הוא היעדרות (noshow ב-attendance) או "רק" טכני.
function isNoShowLoser(g) {
  const loser = g.result === 'tech_a' ? g.a : g.b;
  return (L.attendance?.[g.day]?.[loser]) === 'noshow';
}

// תרומת משחק לכל צד, או null אם אינו נספר (pending/cancelled/ok בלי ניקוד).
// כל הניקוד עשרוני — unfinished=1.5 (6.2) הוא הסיבה שאסור int בשום מקום.
function scoreGame(g) {
  const sc = L.meta.scoring || {};
  const r = g.result;
  if (r === 'pending' || r === 'cancelled') return null;
  const z = () => ({ pts:0, pf:0, pa:0, win:0, loss:0, tech:0, noshow:0, unf:0 });
  const absent = team => (L.attendance?.[g.day]?.[team]) === 'noshow';

  if (r === 'ok') {
    if (g.sa == null || g.sb == null) return null;
    const a = z(), b = z();
    a.pf = g.sa; a.pa = g.sb; b.pf = g.sb; b.pa = g.sa;
    if (g.sa > g.sb)      { a.pts = sc.win; a.win = 1; b.pts = sc.loss; b.loss = 1; }
    else if (g.sb > g.sa) { b.pts = sc.win; b.win = 1; a.pts = sc.loss; a.loss = 1; }
    else                  { a.pts = sc.loss; b.pts = sc.loss; }   // מערכה לא נגמרת בתיקו — הגנה בלבד
    return { a, b };
  }

  if (r === 'tech_a' || r === 'tech_b') {
    const loser = r === 'tech_a' ? 'a' : 'b';
    const wf = sc.walkoverFor ?? 18, wa = sc.walkoverAgainst ?? 10;
    const Ls = z(), Ws = z();
    Ws.pts = sc.win; Ws.win = 1; Ws.pf = wf; Ws.pa = wa;
    Ls.pts = sc.techLoss; Ls.pf = wa; Ls.pa = wf;
    absent(g[loser]) ? (Ls.noshow = 1) : (Ls.tech = 1);
    return loser === 'a' ? { a: Ls, b: Ws } : { a: Ws, b: Ls };
  }

  if (r === 'both_absent') {
    const a = z(), b = z();
    a.pts = sc.techLoss; b.pts = sc.techLoss;   // 0:0, הפרש 0
    a.noshow = 1; b.noshow = 1;                 // both_absent → שתיהן היעדרות
    return { a, b };
  }

  if (r === 'unfinished') {                     // 6.2 — 1.5 לשתיהן, הפרש 0
    const a = z(), b = z();
    a.pts = sc.unfinished; b.pts = sc.unfinished;
    a.unf = 1; b.unf = 1;
    return { a, b };
  }
  return null;
}

// טבלת סטטיסטיקה מלאה לליגה, לכל קבוצה ברוסטר (גם בלי משחקים).
function computeStats(catId) {
  const stat = {};
  for (const t of (L.roster[catId] || []))
    stat[t.id] = { id:t.id, name:t.name || t.id, played:0, wins:0, losses:0,
                   tech:0, noshow:0, unf:0, pf:0, pa:0, pts:0, diff:0 };
  for (const g of (L.games || [])) {
    if (g.cat !== catId) continue;
    const o = scoreGame(g);
    if (!o) continue;
    for (const side of ['a', 'b']) {
      const s = stat[g[side]];
      if (!s) continue;   // קבוצה שנמחקה מהרוסטר אך נשארה במשחק
      const x = o[side];
      s.played++; s.wins += x.win; s.losses += x.loss;
      s.tech += x.tech; s.noshow += x.noshow; s.unf += x.unf;
      s.pf += x.pf; s.pa += x.pa; s.pts += x.pts;
    }
  }
  for (const s of Object.values(stat)) s.diff = s.pf - s.pa;
  return stat;
}

// §2.5 — מיני־ליגה: נקודות והפרש רק ממשחקים שהתקיימו בין חברי idSet.
function miniStandings(catId, idSet) {
  const m = {};
  for (const id of idSet) m[id] = { pts:0, diff:0 };
  for (const g of (L.games || [])) {
    if (g.cat !== catId || !idSet.has(g.a) || !idSet.has(g.b)) continue;
    const o = scoreGame(g);
    if (!o) continue;   // §2.5 — משחקים שבוטלו/טרם שוחקו אינם נספרים במיני־ליגה
    m[g.a].pts += o.a.pts; m[g.a].diff += o.a.pf - o.a.pa;
    m[g.b].pts += o.b.pts; m[g.b].diff += o.b.pf - o.b.pa;
  }
  return m;
}

// האם כל המשחקים *בין* חברי הקבוצה כבר שוחקו (אף אחד לא pending). רק אז שוויון
// מלא הוא באמת מבוי סתום: אם עוד לא נפגשו, המפגש הישיר עדיין יכול להכריע ואין
// להתריע "סתם". cancelled נחשב מוכרע (הקבוצה פרשה, המשחק לא יתקיים) ולא חוסם.
function mutualAllPlayed(catId, idSet) {
  for (const g of (L.games || [])) {
    if (g.cat !== catId || !idSet.has(g.a) || !idSet.has(g.b)) continue;
    if (g.result === 'pending') return false;
  }
  return true;
}

// §2.5 + 3.10.3 — שובר שוויון רקורסיבי לקבוצה ששווה בנקודות ובהפרש הכללי.
// מחזיר בלוקים בסדר סופי: { ids, resolved }. resolved=false = "שוויון מלא" שהתקנון
// לא מכריע. N=2 מייצר אוטומטית "מפגש ישיר" (מיני־ליגה של שתיים = המשחק ביניהן).
function breakTie(catId, group) {
  if (group.length <= 1) return [{ ids: group, resolved: true }];
  const m = miniStandings(catId, new Set(group));
  const key = id => m[id].pts + '|' + m[id].diff;
  const sorted = [...group].sort((x, y) => (m[y].pts - m[x].pts) || (m[y].diff - m[x].diff));
  const subs = [];
  for (const id of sorted) {
    const last = subs[subs.length - 1];
    if (last && key(last[0]) === key(id)) last.push(id);
    else subs.push([id]);
  }
  if (subs.length === 1) return [{ ids: sorted, resolved: false }];   // סימטריה מלאה — לא הופרד
  const out = [];
  for (const sub of subs) out.push(...breakTie(catId, sub));           // רקורסיה על כל תת־קבוצה
  return out;
}

// דירוג מלא לליגה: שורות ממוינות עם מקום, סימון שוויון לא־פתור, והתראות למנהלת.
function rankStandings(catId) {
  const stat = computeStats(catId);
  const rows = Object.values(stat).sort((x, y) => (y.pts - x.pts) || (y.diff - x.diff));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  const groups = [];   // קיבוץ ראשוני לפי (נק׳, הפרש)
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0].pts === r.pts && last[0].diff === r.diff) last.push(r);
    else groups.push([r]);
  }

  const blocks = [];
  for (const grp of groups) {
    if (grp.length === 1) blocks.push({ ids: [grp[0].id], resolved: true });
    else blocks.push(...breakTie(catId, grp.map(r => r.id)));
  }

  const ranked = [], alerts = [];
  let pos = 1;
  for (const b of blocks) {
    if (b.resolved || b.ids.length === 1) {
      for (const id of b.ids) { ranked.push({ row: byId[id], rank: pos, tied: false }); pos++; }
    } else {
      const start = pos, end = pos + b.ids.length - 1;
      const ids = [...b.ids].sort((x, y) => (byId[x].name || '').localeCompare(byId[y].name || '', 'he'));
      // מבוי סתום *אמיתי* (§2.5): כל הקבוצות שיחקו, **וגם** כל המשחקים ביניהן כבר
      // שוחקו ובכל זאת לא הפרידו. אם עוד לא נפגשו — זה שוויון זמני שהמפגש ביניהן
      // עוד יכריע, ואין להתריע "סתם": מציגים מקומות רצופים (לפי שם) בלי סימון.
      const deadEnd = b.ids.every(id => byId[id].played > 0) && mutualAllPlayed(catId, new Set(b.ids));
      if (deadEnd) {
        for (const id of ids) ranked.push({ row: byId[id], rank: start, tied: true, tieRange: [start, end] });
        alerts.push({ start, end, size: b.ids.length, touchesF4: start <= 4 && end >= 5 });
      } else {
        let p = start;
        for (const id of ids) ranked.push({ row: byId[id], rank: p++, tied: false });
      }
      pos += b.ids.length;
    }
  }
  return { ranked, alerts };
}

// §10.2 — הניקוד עשרוני. 1.5 מוצג "1.5", שלמים בלי נקודה.
const fmtPts = p => Number.isInteger(p) ? String(p) : p.toFixed(1);

// קובע result + ניקוד שמור לפי סוג הטכני. sets מתאפס — ליגה סדירה היא מערכה יחידה.
function setTech(g, kind) {
  const sc = L.meta.scoring || {};
  const wf = sc.walkoverFor ?? 18, wa = sc.walkoverAgainst ?? 10;
  g.sets = [];
  if (kind === 'a')         { g.result = 'tech_a';      g.sa = wa;   g.sb = wf;   }
  else if (kind === 'b')    { g.result = 'tech_b';      g.sa = wf;   g.sb = wa;   }
  else if (kind === 'both') { g.result = 'both_absent'; g.sa = 0;    g.sb = 0;    }
  else if (kind === 'unf')  { g.result = 'unfinished';  g.sa = null; g.sb = null; }
  else                      { g.result = 'pending';     g.sa = null; g.sb = null; }   // clear
}

// ============================================================================
// שעון הסלוטים — הבסיס למונה אורך היום (§4.6)
// ============================================================================

const hhmmToMin = t => { const [h,m] = String(t||'0:0').split(':').map(Number); return h*60 + m; };
const minToHhmm = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

// slotIndex הוא 1-based: סלוט 1 = שעת ההתחלה.
export function slotTime(day, slotIndex) {
  return minToHhmm(hhmmToMin(day.startTime) + (slotIndex - 1) * day.slotMin);
}
export function dayEndTime(day) {
  return minToHhmm(hhmmToMin(day.startTime) + day.slots * day.slotMin);
}
// כמה תאים יש ביום, וכמה מהם תפוסים — §4.3: 16×4 = 64, תפוסים 60, פנויים 4.
export function dayCapacity(day) {
  return day.slots * (day.netIds?.length || 0);
}

// ============================================================================
// מצב חי + סנכרון
// ============================================================================

let L    = defaultDoc();
let LREF = null;
let firebaseReady  = false;
let applyingRemote = false;
let saveTimer      = null;

// מלכודת 2 במפרט: onSnapshot נורה פעמיים לכל כתיבה — הד מקומי ואישור שרת.
// המונה skipNextSnapshot שבאפליקציה הישנה מדלג רק על אחת מהשתיים.
// כאן במקומו: הד מקומי מזוהה לפי metadata.hasPendingWrites, ואישור השרת
// מזוהה לפי טביעת אצבע של מה ששלחנו. שתיהן מדולגות, בלי לספור.
const pendingFingerprints = new Set();

// JSON.stringify רגיל לא מתאים כאן: הוא רגיש לסדר המפתחות, ו-Firestore לא
// מחזיר את השדות בסדר שבו נכתבו. בלי מיון, טביעת האצבע של מה ששלחנו לעולם
// לא תתאים לזו שחוזרת, ואישור השרת של הכתיבה שלנו נחשב לשינוי מרוחק.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableStringify(v[k]))
    .join(',') + '}';
}

const fingerprint = data => {
  const { updatedAt, ...rest } = data || {};
  return stableStringify(rest);
};

function setSync(state, detail) {
  const el = document.getElementById('sync-dot');
  const tx = document.getElementById('sync-text');
  if (el) el.className = 'sync-dot sync-' + state;
  if (tx) tx.textContent = detail ||
    ({ ok: t('sync.ok'), wait: t('sync.saving'), err: t('sync.error') }[state] || '');
}

function mergeDefaults(data) {
  const d = defaultDoc();
  // ליגות: ערכי המשתמשת גוברים, אבל שדות חדשים שהמסמך לא מכיר (למשל
  // allowConsecutive שנוסף 25.7) נמשכים מברירת המחדל לפי id — כך תוספת שדה
  // מחלחלת גם למסמכים קיימים בלי לדרוס שם/פורמט שהמשתמשת שינתה.
  const mergeCats = docCats => docCats.map(c => {
    const def = d.categories.find(x => x.id === c.id);
    return def ? { ...def, ...c } : c;
  });
  const merged = {
    meta:         { ...d.meta, ...(data.meta || {}) },
    categories:   data.categories?.length ? mergeCats(data.categories) : d.categories,
    formats:      { ...d.formats, ...(data.formats || {}) },
    players:      data.players      || {},
    roster:       { ...d.roster,  ...(data.roster  || {}) },
    availability: data.availability || {},
    attendance:   data.attendance   || {},
    games:        data.games        || [],
    blocks:       data.blocks       || [],
    ko:           { ...d.ko, ...(data.ko || {}) },
    crossover:    data.crossover    || []
  };
  // שם הקבוצה הוא שדה נגזר — נבנה מחדש מהמרשם בכל טעינה (§5.4). מקומי בלבד:
  // אין כאן כתיבה, ולכן מסמך שנכתב בחלון אחר לא מייצר לולאת שמירה.
  syncTeamNames(merged);
  return merged;
}

// ============================================================================
// טלפונים — דוק פרטי נפרד (§5.4)
// ============================================================================
//
// הטלפונים אינם יושבים בדוק הליגה: הוא ציבורי לקריאה וכתובתו מופצת ל-72
// השחקניות (מלכודת 7). הם יושבים בדוק שכן — tournaments/<id>_private —
// שהאפליקציה הציבורית **לא טוענת בכלל**; רק עמוד הקבוצות של המנהלת יקרא אותו,
// אחרי שיהיו הרשאות (שלב 6). כאן התשתית בלבד: אף אחת מהפונקציות אינה מחווטת
// לממשק, ולכן הדוק גם לא נוצר ואין כרגע טלפון אחד במערכת.
// ⚠️ בלי Firebase Auth זו פרטיות בפועל ולא הרמטית — §5.4.

const PRIVATE_ID = LEAGUE_ID + '_private';
let PRIV = null;   // { phones: { p001:'050-0000000' } } — נטען עצל, פעם אחת
let phoneState = 'idle';   // idle | loading | ready | error

// נקראת מ-renderTeams בלבד (שלב 6). כל עוד המנהלת לא פתחה את עמוד הקבוצות
// הדוק הפרטי לא נקרא — וגם לא נוצר, כי אין כתיבה בלי טלפון ראשון.
function ensurePhones() {
  if (phoneState !== 'idle') return;
  phoneState = 'loading';
  loadPhones()
    .then(() => { phoneState = 'ready'; paint(); })
    .catch(e => { phoneState = 'error'; console.error('Phones load failed', e); paint(); });
}

async function loadPhones() {
  if (PRIV) return PRIV;
  const snap = await getDoc(doc(db, 'tournaments', PRIVATE_ID));
  PRIV = snap.exists() ? (snap.data() || {}) : {};
  PRIV.phones ||= {};
  return PRIV;
}

const phoneOf = pid => PRIV?.phones?.[pid] || '';

async function setPhone(pid, phone) {
  const p = await loadPhones();
  phone ? (p.phones[pid] = phone) : delete p.phones[pid];
  await setDoc(doc(db, 'tournaments', PRIVATE_ID),
               { phones: p.phones, updatedAt: serverTimestamp() });
}

function payload() {
  return {
    meta: L.meta, categories: L.categories, formats: L.formats,
    players: L.players, roster: L.roster,
    availability: L.availability, attendance: L.attendance,
    games: L.games, blocks: L.blocks, ko: L.ko, crossover: L.crossover
  };
}

// כתיבה עם debounce — החלטה 2 ב-§5.2. בלי זה כל גרירה כותבת את הדוק כולו
// ואנחנו חוטפים throttling של Firestore.
export function queueSave() {
  if (!firebaseReady || applyingRemote || !LREF) return;
  setSync('wait');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

async function flushSave() {
  if (!LREF) return;
  const body = payload();
  const fp = fingerprint(body);
  pendingFingerprints.add(fp);
  if (pendingFingerprints.size > 8) {
    pendingFingerprints.delete(pendingFingerprints.values().next().value);
  }
  try {
    // ⚠️ בלי merge, במכוון. payload() מחזיר את המסמך *כולו*, ולכן merge לא
    // מוסיף שום דבר — אבל כן שובר מחיקות: merge רק מוסיף ודורס, ושדה שנמחק
    // מהמודל המקומי היה נשאר ב-Firestore ונטען בחזרה בפעם הבאה. נתפס כש-
    // third:15 שרד מעבר מ"הטוב מ-3" ל"מערכה אחת".
    await setDoc(LREF, { ...body, updatedAt: serverTimestamp() });
    setSync('ok');
  } catch (e) {
    pendingFingerprints.delete(fp);
    console.error('League push failed', e);
    setSync('err', 'לא נשמר: ' + e.message);
  }
}

async function loadLeague() {
  LREF = doc(db, 'tournaments', LEAGUE_ID);

  const snap = await getDoc(LREF);
  if (!snap.exists()) {
    // ⚠️ לא ליצור את הדוק סתם מפני שמישהי פתחה את הדף.
    // בגרסה הראשונה כן יצרנו, ואז טעינה אוטומטית של הדפדפן בלי פרמטרים
    // ייצרה דוק ליגה מלא בשקט. הדוק הזה ציבורי, מזהה שלו מופץ ל-72 שחקניות,
    // וצפייה אינה יצירה. יצירה מחייבת ?init=1 מפורש.
    if (!INIT) return 'missing';
    applyingRemote = true;
    L = defaultDoc();
    await setDoc(LREF, { ...payload(), updatedAt: serverTimestamp() });
    applyingRemote = false;
  } else {
    L = mergeDefaults(snap.data());
  }

  onSnapshot(LREF, s => {
    if (!s.exists()) return;
    if (s.metadata.hasPendingWrites) return;      // ההד המקומי של הכתיבה שלנו
    const data = s.data();
    const fp = fingerprint(data);
    if (pendingFingerprints.has(fp)) {            // אישור השרת לאותה כתיבה
      pendingFingerprints.delete(fp);
      setSync('ok');
      return;
    }
    applyingRemote = true;
    L = mergeDefaults(data);
    applyingRemote = false;
    paint();
    setSync('ok');
  }, err => {
    console.error('League snapshot error', err);
    setSync('err');
  });

  firebaseReady = true;
  return true;
}

// ============================================================================
// הרשאות — §7.1 (שלב 6)
// ============================================================================
//
// שלוש רמות: 0 ציבור · 1 אדמין (הזנת תוצאות בלבד) · 2 מאסטר (הכל).
// המנגנון ממוחזר מ-app.js (adminLevel + refreshAdmin): אותו sha256 מ-common.js
// מול hash שמור ב-meta, אותה החלטה שההרשאה נאכפת בדפדפן בלבד (SECURITY.md).
// שני הבדלים מכוונים:
//   1. **אין בורר תפקיד בדיאלוג.** ב-app.js בוחרים "אדמין/מאסטר" ואז מקלידים;
//      כאן הסיסמה עצמה מכריעה את הרמה. שדה אחד במקום שלושה פקדים.
//   2. **בלי סיסמת מאסטר האתר פתוח.** אחרת המנהלת הייתה ננעלת מחוץ לעמוד
//      ההגדרות — המקום היחיד שבו אפשר להגדיר סיסמה. כל עוד ה-hash ריק כולן
//      מאסטר, והטאב מציג אזהרה שמובילה ישר למקטע "גישה".
const ROLE_KEY = 'futilina-role:' + LEAGUE_ID;

let role          = 0;       // מה שהוקלד בפועל
let previewPublic = false;   // "איך זה נראה לשחקניות" (§8.5)

// האם הליגה בכלל נעולה. ריק = טרם הוגדרה סיסמה.
function secured() { return !!L.meta?.managerPasswordHash; }
// הרמה האמיתית של המשתמשת (בלי קשר לתצוגה המקדימה)
function realRole() { return secured() ? role : 2; }
// **הרמה שכל התצוגה והפעולות נשענות עליהן.** בתצוגה מקדימה המאסטר הופכת
// לציבור לכל דבר — כולל חסימת פעולות, אחרת "כך זה נראה" היה שקר חלקי.
function R() { return previewPublic ? 0 : realRole(); }

// sessionStorage ולא localStorage: רענון בחוף לא מוציא את המנהלת החוצה,
// אבל סגירת הלשונית כן. אין כאן החמרה או הקלה אבטחתית — ההרשאה נאכפת
// בדפדפן ממילא (SECURITY.md), וזה רק חוסך הקלדה חוזרת.
function restoreRole() {
  try {
    const v = +sessionStorage.getItem(ROLE_KEY);
    role = (v === 1 || v === 2) ? v : 0;
  } catch (_) { role = 0; }
}
function storeRole() {
  try { role ? sessionStorage.setItem(ROLE_KEY, role) : sessionStorage.removeItem(ROLE_KEY); }
  catch (_) {}
}

// דיאלוג הכניסה — נבנה פעם אחת ומוזרק ל-body. משתמש ב-.overlay/.modal/.mbtn
// של styles.css, ולכן אין לו CSS חדש. הכפתורים נושאים data-act ועוברים
// דרך אותו handle() כמו כל השאר.
function loginBox() {
  let el = document.getElementById('login-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'login-overlay';
  el.className = 'overlay h';
  el.innerHTML = `
    <div class="modal">
      <h3>${escH(t('auth.login'))}</h3>
      <div class="modal-row">
        <input id="login-pw" class="modal-input" type="password" placeholder="${escH(t('auth.pw'))}"
               autocomplete="current-password"/>
      </div>
      <div id="login-err" class="frm-err h">${escH(t('auth.wrong'))}</div>
      <div class="modal-btns">
        <button class="mbtn mbtn-cancel" data-act="auth.close">${escH(t('auth.cancel'))}</button>
        <button class="mbtn mbtn-ok" data-act="auth.submit">${escH(t('auth.enter'))}</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); ACT['auth.submit'](); }
    if (e.key === 'Escape') { ACT['auth.close'](); }
  });
  return el;
}

function openLogin() {
  const el = loginBox();
  el.classList.remove('h');
  el.querySelector('#login-err').classList.add('h');
  const inp = el.querySelector('#login-pw');
  inp.value = '';
  setTimeout(() => inp.focus(), 60);
}

function closeLogin() {
  const el = document.getElementById('login-overlay');
  if (!el) return;
  el.classList.add('h');
  el.querySelector('#login-pw').value = '';
}

async function tryLogin() {
  const inp = document.getElementById('login-pw');
  const raw = (inp?.value || '').trim();
  const m = L.meta || {};
  const h = raw ? await sha256(raw) : '';
  const lvl = (h && h === m.managerPasswordHash) ? 2
            : (h && h === m.adminPasswordHash)   ? 1 : 0;
  if (!lvl) {
    document.getElementById('login-err')?.classList.remove('h');
    if (inp) { inp.value = ''; inp.focus(); }
    return;
  }
  role = lvl;
  previewPublic = false;
  storeRole();
  closeLogin();
  paint();
}

// ============================================================================
// פרסום — §8.5
// ============================================================================
//
// day.published הוא המתג היחיד. הציבור והאדמין רואים רק ימים מפורסמים
// (§7.1); המאסטר תמיד רואה הכל, ולכן הסינון נגזר מ-R() ולא ממשתנה נפרד.
const todayISO = () => new Date().toISOString().slice(0, 10);

// יום נראה לרמה הנוכחית: מפורסם. זהו.
// היה כאן מתג כללי (showPastDays) שהוריד אוטומטית מחזורים שתאריכם עבר —
// הוסר 18.8: הוא חפף לכפתור ההצגה/הסתרה שיש לכל יום בנפרד (החלטה 16),
// ושני פקדים על אותה שאלה בלבלו יותר משהועילו.
function dayVisible(d) {
  if (R() >= 2) return true;
  return !!d.published;
}

// §8.5 — הפרסום חל גם על טאב הפיינל פור. המתג הוא `published` של יום 'ff',
// אותו שדה ואותה פעולה (`pub.toggle`) של שאר המחזורים — אין מנגנון שני.
const ffDay = () => (L.meta.days || []).find(d => d.id === 'ff');
const ffPublished = () => !!ffDay()?.published;

// הימים שיש להם לוז בפועל ושמותר להציג אותם. ff/cross אינם משובצים לגריד
// (שלב 5) ולכן נושרים כאן מאליהם — הבראקט שלהם יושב בעמוד נפרד.
function schedDaysFor() {
  const has = new Set((L.games || []).filter(g => g.slot && g.net).map(g => g.day));
  return (L.meta.days || []).filter(d => has.has(d.id) && dayVisible(d));
}

// היום שהכי הגיוני לפתוח בו: הקרוב שטרם עבר, אחרת האחרון.
function defaultDayId(list) {
  const t = todayISO();
  return (list.find(d => !d.date || d.date >= t) || list[list.length - 1])?.id || null;
}

const fmtDate = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '';

// ============================================================================
// תצוגה
// ============================================================================

let page = 'standings';

// min = רמת ההרשאה המינימלית לעמוד (§7.1). הציבור מקבל שלושה עמודים בלבד.
const PAGES = [
  { id:'standings', k:'nav.standings', min:0 },
  // "הקבוצה שלי" בוטל (§7.2). כל מה שנשאר ממנו: שדה החיפוש בלוז זוכר את
  // עצמו ב-localStorage. אין עמוד, אין כרטיס "המשחק הבא", אין נעיצה.
  { id:'schedule',  k:'nav.schedule',  min:0 },
  // gate — תנאי נוסף מעל ההרשאה (§8.5): הפיינל פור נסתר מהניווט וחסום כעמוד
  // עד שהמאסטר מפרסם אותו. המאסטר עצמו עובר בזכות R()>=2.
  { id:'ko',        k:'nav.ko',        min:0, gate:ffPublished },
  { id:'teams',     k:'nav.teams',     min:2 },
  { id:'sched',     k:'nav.sched',     min:2 },
  { id:'settings',  k:'nav.settings',  min:2 }
  // 'status' — עמוד אבחון פנימי. הוסר מהניווט (החלטת המשתמשת 18.8); הרנדרר
  // נשאר לשימוש ידני, אבל אין אליו דרך מהאתר.
];

// מקטעי ההגדרות הפתוחים. בלי זה כל הקלדה סוגרת את כל האקורדיון,
// כי paint() בונה מחדש את כל ה-innerHTML.
const openSections = new Set(['general']);

// עמוד מותר לרמה הנוכחית: הרשאה (§7.1) **וגם** ה-gate של העמוד (§8.5).
// המאסטר תמיד עובר — ה-gate של הפיינל פור נגזר מ-R() בעצמו.
const pageOk = p => R() >= p.min && (R() >= 2 || !p.gate || p.gate());

function paint() {
  const f = focusSnapshot();

  applyTheme(L.meta.primaryColor, L.meta.secondaryColor, {
    hasLogo: !!L.meta.logoUrl
  });
  applyFont(L.meta.font);
  applyLogo(L.meta.logoUrl);

  document.getElementById('header-name').textContent = L.meta.name || 'ליגה';
  document.title = L.meta.name || 'ליגה';
  renderLangSwitch();

  // הטאבים לפי ההרשאה (§7.1). עמוד שאינו מותר לרמה הנוכחית נסגר מיד — כך
  // גם יציאה מהמאסטר וגם כניסה לתצוגה המקדימה לא משאירות עמוד סגור פתוח.
  const vis = PAGES.filter(pageOk);
  if (!vis.some(p => p.id === page)) page = vis[0].id;

  document.getElementById('main-nav').innerHTML =
    vis.map(p => `<button class="tab${p.id === page ? ' on' : ''}" data-page="${p.id}">${escH(t(p.k))}</button>`).join('')
    + roleTab();

  const target = PAGES.find(p => p.id === page);
  document.getElementById('page-body').innerHTML = (previewPublic ? previewBar() : '') + (
      page === 'teams'     ? renderTeams()
    : page === 'sched'     ? renderSched()
    : page === 'settings'  ? renderSettings()
    : page === 'status'    ? renderStatus()
    : page === 'standings' ? renderStandings()
    : page === 'schedule'  ? (R() >= 2 ? masterSchedule() : renderPublicSchedule())
    : page === 'ko'        ? KO.render()
    : renderPlaceholder(target));

  renderSponsorBar();
  focusRestore(f);
}

// כפתור הכניסה/היציאה בסוף רצועת הטאבים. אין לו מקום משלו ב-league.html
// (שאותו שלב 6 לא משנה מלבד ה-?v), ולכן הוא נכנס כטאב אחרון.
// מתג השפה. שלוש אותיות בכותרת, בלי תפריט נפתח — שלוש אפשרויות אינן
// מצדיקות פקד שצריך לפתוח כדי לראות מה יש בו.
function renderLangSwitch() {
  const box = document.getElementById('langsw');
  if (!box) return;
  const cur = getLang();
  box.setAttribute('aria-label', t('lang.aria'));
  box.innerHTML = LANGS.map(([code, label]) =>
    `<button class="langsw__b${code === cur ? ' is-on' : ''}" data-act="lang.set" data-lang="${code}"
       lang="${code}" aria-pressed="${code === cur}">${label}</button>`).join('');
}

// שלושה מצבים, ורק אחד מהם גלוי לצופה: **אף אחד**.
//   אין סיסמה  → אזהרה (כולן מאסטר בפועל; חייבת להיות גלויה)
//   מחוברת     → יציאה
//   ‎?m=1‎      → כניסה
//   אחרת       → כלום. השחקניות לא צריכות לדעת שיש דלת.
function roleTab() {
  if (!secured())
    return `<button class="tab role-tab warn" data-act="auth.click"
              title="${escH(t('auth.nopassT'))}">${escH(t('auth.nopass'))}</button>`;
  const r = realRole();
  if (r) return `<button class="tab role-tab on" data-act="auth.click"
            title="${escH(t('auth.exitT'))}">${escH(t(r === 2 ? 'auth.master' : 'auth.admin'))} ✓</button>`;
  return MGR ? `<button class="tab role-tab" data-act="auth.click">${escH(t('auth.login'))}</button>` : '';
}

// §8.5 — "איך זה נראה לשחקניות". לא סימולציה: R() באמת יורד ל-0, ולכן גם
// הטאבים, גם הימים המוסתרים וגם הפעולות נחסמים בדיוק כמו אצל שחקנית.
function previewBar() {
  return `<div class="prev-bar">
    <span><b>תצוגת שחקניות.</b> זה בדיוק מה שרואה מי שנכנסת לקישור הציבורי —
      ימים מוסתרים, הזנת תוצאות ולוח הגרירה אינם כאן.</span>
    <button class="cf-btn" data-act="pub.exit">חזרה למצב מאסטר</button>
  </div>`;
}

// כמו paint(), אבל שומר את מיקום הגלילה (חלון + אזורים פנימיים עם data-sk). כל
// לחיצה/שינוי מרנדרת מחדש את page-body ומאפסת גלילה לראש — זה מה שגרם לדף "לקפוץ
// למעלה" בכל פעולה. משמש בכל הפעולות (handle); החלפת טאב נשארת paint() רגיל (עולה
// לראש במכוון). סינכרוני עם void offsetHeight כדי שהקביעה לא תיחתך לפני layout.
function paintKeepScroll() {
  const x = window.scrollX, y = window.scrollY, inner = {};
  document.querySelectorAll('[data-sk]').forEach(el => inner[el.dataset.sk] = { t: el.scrollTop, l: el.scrollLeft });
  paint();
  void document.body.offsetHeight;
  window.scrollTo(x, y);
  document.querySelectorAll('[data-sk]').forEach(el => { const v = inner[el.dataset.sk]; if (v) { el.scrollTop = v.t; el.scrollLeft = v.l; } });
}

// ============ מיתוג ============

// שלושה פונטים עבריים בלבד. Barlow ואחיו לטיניים ומפילים את כל העברית
// לפונט מערכת (מלכודת 4), ולכן הרשימה סגורה ולא שדה חופשי.
const FONTS = ['Rubik', 'Heebo', 'Assistant'];

function applyFont(font) {
  const name = FONTS.includes(font) ? font : 'Rubik';
  let link = document.getElementById('font-link');
  if (!link) {
    link = document.createElement('link');
    link.id = 'font-link'; link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const href = `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700;800;900&display=swap`;
  if (link.href !== href) link.href = href;
  document.body.style.fontFamily = `'${name}', sans-serif`;
}

function applyLogo(url) {
  const img = document.getElementById('logo-img');
  const letter = document.getElementById('logo-letter');
  if (!img || !letter) return;
  if (url) {
    img.src = url; img.style.display = '';
    img.onerror = () => { img.style.display = 'none'; letter.style.display = ''; };
    letter.style.display = 'none';
  } else {
    img.style.display = 'none'; img.removeAttribute('src');
    letter.style.display = '';
  }
}

function renderSponsorBar() {
  const bar = document.getElementById('sponsor-bar');
  const logos = (L.meta.sponsorLogos || []).filter(l => l && (l.url || l.alt));
  bar.classList.toggle('h', logos.length === 0);
  bar.innerHTML = logos.map(l => l.url
    ? `<img class="sponsor-logo" src="${escH(l.url)}" alt="${escH(l.alt || '')}" title="${escH(l.alt || '')}"/>`
    : `<span class="sponsor-text">${escH(l.alt || '')}</span>`
  ).join('');
}

// רשת ביטחון בלבד — כל שבעת העמודים ב-PAGES מרונדרים בפועל.
function renderPlaceholder(p) {
  return `<div class="sett-section empty">
    <h3>${escH(p?.label || '')}</h3>
    <p>העמוד הזה אינו זמין.</p>
  </div>`;
}

// ============================================================================
// עמוד קבוצות — §14 שלב 2
// ============================================================================

// רשימת ההשלמה האוטומטית — כל השמות שכבר במרשם (§5.4). שם שנבחר מהרשימה
// משייך את אותה שחקנית, וכך אותה שחקנית בשאו ובליגה מקבלת מזהה זהה.
function playerOptions() {
  return [...new Set(Object.values(L.players || {}).map(p => p.name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'he'))
    .map(n => `<option value="${escH(n)}"></option>`).join('');
}

// טקסט הסימון ⇄: היכן עוד השחקנית הזאת משחקת.
const sharedTip = rest =>
  'משחקת גם ב-' + rest.map(x => `״${x.team.name || x.team.id}״ (${CAT_NAME(x.cat)})`).join(', ');

// כמה משחקים לקבוצה בכל מחזור — "3 · 4 · 4 · 3" של §8.6. חלק מ"מידע מלא
// לכל קבוצה": זה מה שמגלה בעין קבוצה שקיבלה יום ריק או יום עמוס.
function teamDayCounts(id) {
  const days = regularDays();
  const n = days.map(d => (L.games || []).filter(g =>
    g.day === d.id && (g.a === id || g.b === id)).length);
  if (!n.some(Boolean)) return '';
  return `<span class="team-meta" title="משחקים לפי מחזור: ${escH(days.map((d, i) => `${d.label} ${n[i]}`).join(' · '))}"
    >${n.join(' · ')}</span>`;
}

function renderTeams() {
  // שלושה שדות שם במקום בורר גודל (החלטת המשתמשת 24.7): 2 מלאים = זוג,
  // 3 = שלישייה. אין כפתור פעילה/פרשה (פרישה נדירה — מחיקה או "טכני" פר משחק,
  // §10.3), ואין קוד מזהה גלוי (פנימי — המנהלת לא צריכה אותו, וגם לא את p001).
  const usage  = playerTeams();
  const shared = Object.values(usage).filter(l => l.length > 1).length;

  // הטלפונים נטענים מהדוק הפרטי רק כאן ורק עכשיו (§5.4, אפשרות ב׳).

  const cards = L.categories.map(c => {
    const list = L.roster[c.id] || [];
    const PH = ['שחקנית ראשונה', 'שחקנית שנייה', 'שחקנית שלישית (רשות)'];
    const rows = list.map((t, i) => {
      const p = teamSlots(t);
      const fields = [0, 1, 2].map(s => {
        const pid  = isPid(p[s]) ? p[s] : '';
        const rest = (usage[pid] || []).filter(x => x.team.id !== t.id);
        return `
        <label class="player-slot${rest.length ? ' shared' : ''}"${rest.length ? ` title="${escH(sharedTip(rest))}"` : ''}>
          <input class="text-inp team-player-inp" list="players-reg" autocomplete="off"
                 value="${escH(slotName(p[s]))}" placeholder="${PH[s]}"
                 data-act="team.player" data-id="${escH(t.id)}" data-slot="${s}"/>
        </label>`;
      }).join('');
      return `
      <div class="team-row">
        <span class="team-num">${i + 1}</span>
        ${teamDayCounts(t.id)}
        <div class="team-players">${fields}</div>
        <button class="team-del" data-act="team.del" data-id="${escH(t.id)}" title="מחיקה">×</button>
      </div>`;
    }).join('');

    return `
    <div class="sett-section">
      <div class="sett-section-title">${escH(c.name)}
        <span class="muted">— ${list.length} קבוצות</span></div>
      ${rows || '<div class="sett-empty-note">אין עדיין קבוצות בליגה הזאת.</div>'}
      <div class="sett-add-row">
        <button class="add-cat-btn" data-act="team.add" data-cat="${escH(c.id)}">+ קבוצה</button>
      </div>
    </div>`;
  }).join('');

  return `
  <datalist id="players-reg">${playerOptions()}</datalist>
  <div class="info-box">
    שחקנית שכבר הוזנה מוצעת להשלמה בזמן ההקלדה — בחירה בה מסמנת
    ש<strong>זו אותה שחקנית</strong> בשתי הקבוצות.
    שינוי שם מתעדכן מאליו בכל משחקי הקבוצה.
  </div>
  <div id="shared-note" class="sett-empty-note${shared ? '' : ' h'}">
    ${shared} שחקניות רשומות בשתי קבוצות — מסומנות ⇄.
  </div>
  ${cards}`;
}

// עדכון כירורגי של הרוסטר אחרי שינוי במשבצת שחקנית. paint() מלא היה מנתק את
// השדה שהמנהלת כבר עברה אליו (באג 2 בשלב 2), ולכן 'team.player' נשאר
// ב-NO_REPAINT ורק מה שבאמת יכול היה להשתנות מתעדכן: השם הקנוני בכל סלוט
// שמצביע על אותה שחקנית (שינוי שם מחלחל לקבוצה השנייה), סימון ⇄ בשני הצדדים,
// רשימת ההשלמה ושורת הסיכום.
function syncRosterInputs() {
  const usage = playerTeams();
  document.querySelectorAll('input[data-act="team.player"]').forEach(inp => {
    const f = findTeam(inp.dataset.id); if (!f) return;
    const v    = teamSlots(f.team)[+inp.dataset.slot] || '';
    const rest = (isPid(v) ? (usage[v] || []) : []).filter(x => x.team.id !== f.team.id);
    if (inp !== document.activeElement) inp.value = slotName(v);
    const box = inp.closest('.player-slot');
    if (!box) return;
    box.classList.toggle('shared', rest.length > 0);
    if (rest.length) box.title = sharedTip(rest);
    else box.removeAttribute('title');
  });
  const dl = document.getElementById('players-reg');
  if (dl) dl.innerHTML = playerOptions();
  const note = document.getElementById('shared-note');
  if (note) {
    const n = Object.values(usage).filter(l => l.length > 1).length;
    note.classList.toggle('h', n === 0);
    note.textContent = `${n} שחקניות רשומות בשתי קבוצות — מסומנות ⇄.`;
  }
}

// ============================================================================
// עמוד המתזמן — §14 שלב 3
// ============================================================================
//
// שלושת השלבים של §6.1 מופיעים כשלושה כפתורים נפרדים, כי המפרט דורש שכל אחד
// יהיה ניתן להרצה בנפרד. הדוח לא נשמר ב-Firestore אלא נגזר מחדש מ-L.games בכל
// רינדור (analyze) — כך העמוד מראה את אותם מספרים בין אם הלוז נוצר עכשיו ובין
// אם הוא נטען מהמסמך, ואותה פונקציה תזין את סרגל האזהרות של §9 בשלב 5.

// ימי הליגה הסדירה. הפיינל פור והצלבה נבנים בשלב 7 ואינם חלק מה-RR; מזהי
// הימים נקבעים ב-defaultDays() ואינם ניתנים לעריכה בהגדרות, ולכן זיהוי לפי
// מזהה בטוח כאן.
const KO_DAY_IDS = new Set(['ff', 'cross']);
const regularDays = () => (L.meta.days || []).filter(d => !KO_DAY_IDS.has(d.id));

let schedBusy = false;
let schedDay  = null;     // איזה יום מוצג בגריד
let schedLast = null;     // הדוח של ההרצה האחרונה (זמן ריצה, אזהרות מהגנרטור)

// תמונת המצב שהמתזמן מקבל. רק קבוצות פעילות נכנסות ל-RR — קבוצה שפרשה
// לא אמורה לקבל משחקים חדשים (6.1).
function schedInput() {
  return {
    categories: L.categories.map(c => ({
      id: c.id, name: c.name, rr: c.rr, order: c.order, fixedNet: c.fixedNet,
      allowConsecutive: !!c.allowConsecutive,
      teams: (L.roster[c.id] || []).filter(t => t.active !== false).map(t => t.id)
    })),
    days: regularDays().map(d => ({
      id: d.id, label: d.label, startTime: d.startTime,
      slotMin: d.slotMin, slots: d.slots, netIds: d.netIds || []
    })),
    blocks: L.blocks || [],
    availability: L.availability || {},
    // §5.4 — זוגות קבוצות שחולקות שחקנית. המתזמן כבר מכיר את השדה ומעניש
    // שיבוץ צפוף שלהן (linkedOverlap); הפיכתו לאילוץ קשיח על שיבוץ *מקביל*
    // היא שלב 3 של §5.4 ותיעשה ב-league-sched.js. בלי שחקניות משותפות
    // הרשימה ריקה וההתנהגות זהה לחלוטין לקודם.
    links: sharedTeamPairs(),
    existing: L.games || []
  };
}

// מה בנוי כרגע — שלושת השלבים הם שלוש שאלות נפרדות על אותו מערך משחקים
function schedState() {
  const g = L.games || [];
  return {
    games: g.length,
    rr:    g.length > 0,
    days:  g.length > 0 && g.every(x => x.day),
    pack:  g.length > 0 && g.every(x => x.slot && x.net)
  };
}

// דוח חי מתוך L.games: אותה פונקציית עלות של §6.2, על השיבוץ השמור.
function analyze() {
  const input = schedInput();
  const games = L.games || [];

  const total = {};
  for (const g of games) {
    total[g.a] = (total[g.a] || 0) + 1;
    total[g.b] = (total[g.b] || 0) + 1;
  }
  const D = Math.max(1, input.days.length);
  const bounds = {};
  for (const [t, n] of Object.entries(total))
    bounds[t] = { lo: Math.floor(n / D), hi: Math.ceil(n / D) };

  const days = {};
  for (const day of input.days) {
    const dayGames = games.filter(g => g.day === day.id);
    if (!dayGames.length) { days[day.id] = { day, games: [] }; continue; }
    const ctx = buildDayContext(input, day, dayGames, bounds);
    const place = new Map();
    for (const g of dayGames) if (g.slot && g.net) place.set(g.key, { slot: g.slot, net: g.net });
    days[day.id] = { day, ctx, games: dayGames, place,
                     cost: dayCost(place, ctx), length: dayLength(place, ctx) };
  }
  return { input, days, bounds };
}

function runScheduler(phases) {
  // הרצה מלאה של 240 משחקים לוקחת ~2 שניות. בלי הצעד הזה הדפדפן קופא בלי
  // שום חיווי; כאן הוא מצייר "מחשב…" ורק אחר כך נכנס לחישוב.
  schedBusy = true; paint();
  setTimeout(() => {
    const t0 = performance.now();
    try {
      const { games, report } = generateSeason(schedInput(), { phases });
      L.games = games;
      report.ms = Math.round(performance.now() - t0);
      schedLast = report;
      queueSave();
    } catch (e) {
      console.error('Scheduler failed', e);
      schedLast = { fatal: e.message, warnings: [], errors: [], categories: {}, days: {} };
    }
    schedBusy = false;
    paint();
  }, 30);
}

const NET_NAME  = id => (L.meta.nets || []).find(n => n.id === id)?.name  || ('רשת ' + id);
const NET_COLOR = id => (L.meta.nets || []).find(n => n.id === id)?.color || '#888888';
const CAT_NAME  = id => L.categories.find(c => c.id === id)?.name || id;
const TEAM_NAME = id => findTeam(id)?.team.name || id;

// חיווט שלב 7 (פיינל פור + הצלבה). מוצב כאן, אחרי CAT_NAME/TEAM_NAME, כדי
// שלא ליפול ל-TDZ של ה-const-ים (הם לא hoisted). paint()/queueSave/rankStandings/
// validSet הן function declarations ולכן מותרות. הפעולות של המודול נושאות data-ko
// עם מאזין משלו — לא דרך handle() — כדי שהחלפת לשונית לא תכתוב את המסמך.
KO.init({ getL: () => L, queueSave, repaint: paint, rankStandings,
          teamName: TEAM_NAME, catName: CAT_NAME, validSet });

function renderSched() {
  const st = schedState();
  const rosterCount = L.categories.map(c => (L.roster[c.id] || []).filter(t => t.active !== false).length);
  const anyTeams = rosterCount.some(n => n >= 2);
  const days = regularDays();

  const intro = '';

  if (!anyTeams) return intro + `
    <div class="sett-section empty">
      <h3>אין עדיין קבוצות</h3>
      <p>המתזמן צריך לפחות שתי קבוצות פעילות בליגה אחת.
         אפשר להזין אותן בעמוד <b>קבוצות</b>.</p>
      ${DEV ? `<div class="sett-add-row"><button class="add-cat-btn" data-act="sched.seed">
         מילוי רוסטר בדיקה (15 · 15 · 6)</button></div>` : ''}
    </div>`;

  // ── פקדים ──
  const busy = schedBusy ? ' disabled' : '';
  const controls = `
  <div class="sett-section">
    <div class="sett-section-title">הרצה</div>
    <div class="sched-actions">
      <button class="cf-btn" data-act="sched.all"${busy}>צור לוז מלא</button>
      <button class="filter-btn" data-act="sched.rr"${busy}>קבע מי נגד מי</button>
      <button class="filter-btn" data-act="sched.days"${busy}${st.rr ? '' : ' disabled'}>חלק לימים</button>
      <button class="filter-btn" data-act="sched.pack"${busy}${st.days ? '' : ' disabled'}>סדר בגריד</button>
      <button class="team-del sched-clear" data-act="sched.clear"${busy}>מחיקת הלוז</button>
    </div>
    <div class="sched-state">
      ${chip('מפגשים', st.rr, st.games ? `${st.games} משחקים` : '')}
      ${chip('ימים', st.days, st.days ? `${days.length} מחזורים` : '')}
      ${chip('סידור', st.pack, '')}
      ${schedBusy ? '<span class="status-badge badge-pending">מחשב…</span>' : ''}
      ${schedLast?.ms != null ? `<span class="muted">ההרצה האחרונה: ${schedLast.ms} מ״ש</span>` : ''}
    </div>
  </div>`;

  const msgs = [
    ...(schedLast?.fatal ? [['err', 'המתזמן נפל: ' + schedLast.fatal]] : []),
    ...(schedLast?.errors || []).map(t => ['err', t]),
    ...(schedLast?.warnings || []).map(t => ['warn', t])
  ];
  const messages = msgs.length ? `
  <div class="sett-section">
    <div class="sett-section-title">הודעות מההרצה</div>
    ${msgs.map(([k, t]) => `<div class="sched-msg ${k}">${escH(t)}</div>`).join('')}
  </div>` : '';

  if (!st.rr) return intro + controls + messages + rrTable();

  const A = analyze();

  // ── סיכום העונה: תוצאות אנושיות, לא ערכי פונקציית עלות ──
  const seasonRows = days.map(d => {
    const r = A.days[d.id];
    if (!r || !r.games.length) return `<tr><td>${escH(d.label)}</td>
      <td class="num">0</td><td colspan="4"><em>אין משחקים</em></td></tr>`;
    const wins = Object.entries(windowsFrom(r));
    const q = dayQuality(r);
    const waitTxt = q.maxWait <= 1 ? 'סלוט אחד' : `${q.maxWait} סלוטים`;
    const ok = q.hard.length === 0 && q.b2b === 0;
    return `<tr>
      <td>${escH(d.label)}</td>
      <td class="num">${r.games.length}</td>
      <td class="wins">${wins.map(([c, w]) => w
        ? `<span class="win-pill">${escH(CAT_NAME(c))} <b class="num">${slotLabel(d, w.from)}–${slotLabel(d, w.to + 1)}</b></span>`
        : '').join('')}</td>
      <td class="num">${escH(r.length.endTime)}</td>
      <td class="num">${escH(waitTxt)}</td>
      <td>${q.hard.length ? `<span class="status-badge badge-rejected">${q.hard.length} בעיות</span>`
           : q.b2b ? `<span class="status-badge badge-pending">${q.b2b} רצפים</span>`
           : `<span class="status-badge badge-approved">תקין</span>`}</td>
    </tr>`;
  }).join('');

  const season = `
  <div class="sett-section">
    <div class="sett-section-title">העונה</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>מחזור</th><th>משחקים</th><th>מתי כל ליגה משחקת</th><th>סיום</th>
        <th>המתנה מקס׳</th><th>מצב</th></tr></thead>
      <tbody>${seasonRows}</tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:10px">"מתי כל ליגה משחקת" = הסלוט
      הראשון והאחרון שבו כל ליגה על המגרש — כך יודעים מתי להגיע. "המתנה מקס׳" =
      זמן ההמתנה הארוך ביותר של קבוצה בין שני משחקים; סלוט אחד (≈20 דק׳) הוא האידיאל.</span>
  </div>`;

  if (!st.days) return intro + controls + messages + season + rrTable();

  // ── היום הנבחר ──
  if (!schedDay || !A.days[schedDay]) schedDay = days.find(d => A.days[d.id]?.games.length)?.id || days[0]?.id;
  const sel = A.days[schedDay];

  const picker = `<div class="day-picker">${days.map(d =>
    `<button class="filter-btn${d.id === schedDay ? ' on' : ''}" data-act="sched.day" data-day="${escH(d.id)}"
      >${escH(d.label)}</button>`).join('')}</div>`;

  const detail = sel && sel.games.length ? `
  <div class="sett-section">
    <div class="sett-section-title">${escH(sel.day.label)}</div>
    ${picker}
    ${qualityChips(sel)}
    ${hardList(sel)}
    ${st.pack ? grid(sel) : '<div class="info-box">השלב ג׳ עוד לא רץ — אין סלוטים ורשתות.</div>'}
    ${lengthCounter(sel)}
    ${DEV ? `<details class="tech">
      <summary>פרטים טכניים — פונקציית העלות (§6.2) ואבחון (dev)</summary>
      ${costChips(sel.cost)}
      ${violationList(sel)}
    </details>` : ''}
  </div>` : `<div class="sett-section">${picker}<div class="empty">אין משחקים ביום הזה.</div></div>`;

  return intro + controls + messages + season + detail + rrTable();
}

const chip = (label, on, extra) =>
  `<span class="status-badge ${on ? 'badge-approved' : 'badge-pending'}">${escH(label)}${
    on && extra ? ' · ' + escH(extra) : ''}</span>`;

// חלונות ההגעה מהשיבוץ השמור (אותו חישוב שהמתזמן מחזיר, כאן על L.games)
function windowsFrom(r) {
  const out = {};
  for (const c of r.ctx.cats) {
    let lo = Infinity, hi = 0, n = 0;
    for (const g of r.games) {
      if (g.cat !== c.id || !g.slot) continue;
      n++; lo = Math.min(lo, g.slot); hi = Math.max(hi, g.slot);
    }
    out[c.id] = n ? { from: lo, to: hi, games: n } : null;
  }
  return out;
}

// ── תוצאות אנושיות ליום ──
// המנהלת לא צריכה לדעת ש"העלות 3,740"; היא צריכה לדעת אם מישהי משחקת פעמיים
// ברצף, כמה מחכים, ומתי היום נגמר. זה גוזר בדיוק את זה מהשיבוץ.
function dayQuality(r) {
  // ליגה שמתירה רצף נדיר (ליגה ב׳, החלטת המשתמשת): רצף בה **מותר** ולכן לא
  // נספר כבעיה. רצף בשאר הליגות (שואו/א׳) הוא הפרה של החלטה 3.
  const allowB2B = new Set((L.categories || []).filter(c => c.allowConsecutive).map(c => c.id));
  const teamCat = {};
  for (const g of r.games) { teamCat[g.a] = g.cat; teamCat[g.b] = g.cat; }

  const perTeam = {};
  for (const g of r.games) if (g.slot) for (const t of [g.a, g.b]) (perTeam[t] ??= []).push(g.slot);
  let b2b = 0, allowedB2B = 0, maxWait = 0;
  for (const [t, slots] of Object.entries(perTeam)) {
    slots.sort((a, b) => a - b);
    for (let i = 0; i + 1 < slots.length; i++) {
      const w = slots[i + 1] - slots[i] - 1;   // סלוטים ריקים בין שני משחקים
      if (w === 0) { allowB2B.has(teamCat[t]) ? allowedB2B++ : b2b++; }
      else if (w > maxWait) maxWait = w;
    }
  }
  // קוהרנטיות רשת (החלטת המשתמשת): רשת שמארחת שתי ליגות **חייבת** מעבר אחד —
  // זה נקי. הבעיה היא רשת ש**קופצת הלוך-ושוב** (2+ מעברים). סופרים רק את אלה.
  const perNet = {};
  for (const g of r.games) if (g.slot && g.net) (perNet[g.net] ??= []).push(g);
  let flipNets = 0;
  for (const list of Object.values(perNet)) {
    list.sort((a, b) => a.slot - b.slot);
    let jumps = 0;
    for (let i = 1; i < list.length; i++) if (list[i].cat !== list[i - 1].cat) jumps++;
    if (jumps >= 2) flipNets++;
  }
  const hard = (r.cost?.violations || []).filter(x => x.cost >= 1_000_000);
  return { b2b, allowedB2B, maxWait, flipNets, hard };
}

function qualityChips(r) {
  const q = dayQuality(r);
  const sm = r.day.slotMin;
  const c = [];
  const b2bCatName = (L.categories || []).find(c => c.allowConsecutive)?.name || 'ליגה ב׳';
  c.push(q.b2b === 0
    ? `<span class="q-chip good">✓ אף קבוצה לא משחקת פעמיים ברצף</span>`
    : `<span class="q-chip bad">⚠ ${q.b2b} ${q.b2b === 1 ? 'קבוצה משחקת' : 'קבוצות משחקות'} פעמיים ברצף</span>`);
  if (q.allowedB2B)
    c.push(`<span class="q-chip">${q.allowedB2B} ${q.allowedB2B === 1 ? 'משחק רצוף' : 'משחקים רצופים'} ב${escH(b2bCatName)} (מותר מדי פעם)</span>`);
  c.push(q.maxWait <= 1
    ? `<span class="q-chip good">✓ המתנה של סלוט אחד לכל היותר (≈${sm} דק׳)</span>`
    : `<span class="q-chip">המתנה מקסימלית ${q.maxWait} סלוטים (≈${q.maxWait * sm} דק׳) — רובן סלוט אחד</span>`);
  // קוהרנטיות רשת (החלטת המשתמשת): אזהרה רק על רשתות שקופצות הלוך-ושוב
  c.push(q.flipNets === 0
    ? `<span class="q-chip good">✓ כל רשת מארחת ליגה ברצף</span>`
    : `<span class="q-chip bad">⚠ ${q.flipNets} ${q.flipNets === 1 ? 'רשת קופצת' : 'רשתות קופצות'} בין ליגות</span>`);
  c.push(`<span class="q-chip">היום נגמר ב-<b class="num">${escH(r.length.endTime)}</b></span>`);
  return `<div class="q-chips">${c.join('')}</div>`;
}

// בעיות קשיחות בלבד — נדיר, אבל חייב לקפוץ לעין בלי לפתוח "פרטים טכניים".
function hardList(r) {
  const hard = (r.cost?.violations || []).filter(x => x.cost >= 1_000_000);
  if (!hard.length) return '';
  const groups = {};
  for (const x of hard) (groups[x.kind] ??= []).push(x);
  return `<div class="hard-list">${Object.entries(groups).map(([k, list]) =>
    `<div class="sched-msg err">⚠ ${escH(VIOL_LABELS[k] || k)} — ${list.length}</div>`).join('')}</div>`;
}

const COST_LABELS = {
  hard: 'קשיח', backToBack: 'רצף', gamesOver: 'יותר מהמכסה',
  gamesUnder: 'פחות מהמכסה', longWait: 'המתנה', span: 'טווח נוכחות', emptyCell: 'תאים ריקים'
};

function costChips(cost) {
  const items = Object.entries(cost.breakdown)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return `<div class="cost-chips">
    <span class="cost-chip total">עלות <b class="num">${cost.total.toLocaleString('en')}</b></span>
    ${items.map(([k, v]) => `<span class="cost-chip${k === 'hard' ? ' bad' : ''}">${escH(COST_LABELS[k] || k)}
      <b class="num">${v.toLocaleString('en')}</b></span>`).join('')}
    ${items.length ? '' : '<span class="cost-chip">אפס הפרות</span>'}
  </div>`;
}

// רשימת ההפרות. אותו מבנה נתונים יזין את סרגל האזהרות של §9 בשלב 5, ולכן
// הקיבוץ הוא לפי kind ולא לפי טקסט.
function violationList(r) {
  const v = r.cost.violations;
  if (!v.length) return '';
  const groups = {};
  for (const x of v) (groups[x.kind] ||= []).push(x);
  const order = Object.entries(groups).sort((a, b) =>
    b[1].reduce((s, x) => s + x.cost, 0) - a[1].reduce((s, x) => s + x.cost, 0));

  return `<div class="viol-wrap">${order.map(([kind, list]) => {
    const hard = list[0].cost >= 1_000_000;
    return `<details class="viol${hard ? ' hard' : ''}">
      <summary><b>${escH(VIOL_LABELS[kind] || kind)}</b>
        <span class="muted">${list.length}</span></summary>
      <ul>${list.slice(0, 12).map(x => `<li>${
        escH(x.text.replace(/\b([sl]\d?t\d+)\b/g, (_, id) => TEAM_NAME(id)))
      }${x.slot ? ` <span class="muted num">${slotLabel(r.day, x.slot)}</span>` : ''}${
        x.net ? ` <span class="muted">${escH(NET_NAME(x.net))}</span>` : ''}</li>`).join('')}
        ${list.length > 12 ? `<li class="muted">…ועוד ${list.length - 12}</li>` : ''}</ul>
    </details>`;
  }).join('')}</div>`;
}

const VIOL_LABELS = {
  doubleBooked:'אותה קבוצה פעמיים באותו סלוט', cellClash:'שני משחקים על אותו תא',
  blockedCell:'משחק על תא חסום', availability:'חריגה מחלון זמינות',
  noReferee:'אין שופטת (5.2/5.3)', wrongNet:'רשת קבועה — שיבוץ שגוי',
  backToBack:'שני משחקים ברצף', tooMany:'יותר מהמכסה היומית',
  tooFew:'פחות מהמכסה היומית', noGames:'קבוצה בלי אף משחק ביום',
  longWait:'המתנה של יותר מסלוט אחד'
};

function grid(r) {
  const day = r.day, nets = r.ctx.netIds;
  const at = new Map();
  for (const g of r.games) if (g.slot && g.net) at.set(g.slot + '|' + g.net, g);
  const blocks = new Map();
  for (const b of (L.blocks || [])) if (b.day === day.id) blocks.set(b.slot + '|' + b.net, b);

  const head = `<tr><th class="sg-time">שעה</th>${nets.map(n =>
    `<th style="background:${escH(NET_COLOR(n))};color:${onColor(NET_COLOR(n))}">${escH(NET_NAME(n))}</th>`
  ).join('')}</tr>`;

  const rows = Array.from({ length: day.slots }, (_, i) => {
    const s = i + 1;
    return `<tr>
      <td class="sg-time num">${escH(slotLabel(day, s))}</td>
      ${nets.map(n => {
        const g = at.get(s + '|' + n), b = blocks.get(s + '|' + n);
        if (b) return `<td class="sg-cell blocked">${escH(b.label || b.kind)}</td>`;
        if (!g) return `<td class="sg-cell empty"></td>`;
        return `<td class="sg-cell" style="--gc:${escH(NET_COLOR(n))}">
          <span class="sg-cat">${escH(CAT_NAME(g.cat))}</span>
          <span class="sg-team">${escH(TEAM_NAME(g.a))}</span>
          <span class="sg-team">${escH(TEAM_NAME(g.b))}</span>
        </td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `<div class="tscroll"><table class="stbl sgrid">
    <thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

// §4.6 — כל תא שיישמר לליגה שלישית מאריך את המחזור
function lengthCounter(r) {
  const L2 = r.length;
  return `
  <div class="len-counter">
    <div class="len-now">
      <span>סיום בפועל <b class="num">${escH(L2.endTime)}</b></span>
      <span>תאים תפוסים <b class="num">${L2.used}</b></span>
      <span>חסימות <b class="num">${L2.blocks}</b></span>
      <span>פנויים <b class="num">${L2.freeCells}</b></span>
    </div>
    <table class="stbl len-proj">
      <thead><tr><th>תאים לליגה שלישית</th>${L2.projection.map(p =>
        `<th class="num">${p.extra}</th>`).join('')}</tr></thead>
      <tbody><tr><td>סיום המחזור</td>${L2.projection.map(p =>
        `<td class="num">${escH(p.endTime)}</td>`).join('')}</tr></tbody>
    </table>
    <span class="sett-desc">חסם תחתון: ⌈תאים ÷ רשתות⌉. איפה בדיוק המנהלת תניח
      את התאים ייקבע בלוח הגרירה (שלב 5), ולכן הסיום האמיתי יכול להיות מאוחר
      יותר — לא מוקדם.</span>
  </div>`;
}

// שלב א׳ — כמה משחקים כל ליגה מייצרת (כל אחת נגד כל אחת)
function rrTable() {
  const rows = L.categories.map(c => {
    const n = (L.roster[c.id] || []).filter(t => t.active !== false).length;
    if (n < 2) return `<tr><td>${escH(c.name)}</td><td class="num">${n}</td>
      <td colspan="3"><em>פחות משתי קבוצות</em></td></tr>`;
    const rr = c.rr || 1;
    return `<tr>
      <td>${escH(c.name)}</td>
      <td class="num">${n}</td>
      <td class="num">${rr === 2 ? 'פעמיים' : 'פעם אחת'}</td>
      <td class="num">${n * (n - 1) / 2 * rr}</td>
      <td class="num">${(n - 1) * rr}</td>
    </tr>`;
  }).join('');

  return `
  <div class="sett-section">
    <div class="sett-section-title">שלב א׳ — כמה משחקים בכל ליגה</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>ליגה</th><th>קבוצות</th><th>נפגשות</th><th>סה״כ משחקים</th>
        <th>לכל קבוצה</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ============================================================================
// עמוד הגדרות — §12: שישה מקטעים מתקפלים
// ============================================================================

function section(id, title, body) {
  return `<details class="sett-section acc" id="sec-${id}"${openSections.has(id) ? ' open' : ''}>
    <summary class="sett-section-title">${escH(title)}</summary>
    <div class="acc-body">${body}</div>
  </details>`;
}

function row(name, desc, ctrl) {
  return `<div class="sett-row">
    <div class="sett-label">
      <span class="sett-name">${escH(name)}</span>
      ${desc ? `<span class="sett-desc">${desc}</span>` : ''}
    </div>
    <div class="sett-ctrl">${ctrl}</div>
  </div>`;
}

// בורר צבע כפול — בדיוק התבנית של app.js: לוח צבעים חי ב-oninput לצד שדה
// hex שנשמר ב-onchange. הצבע הוא היוצא מן הכלל היחיד לכלל ה-onchange
// (מלכודת 3), כי גרירה בלוח חייבת משוב מיידי.
function colorRow(key, label, desc) {
  const val = L.meta[key] || '#000000';
  return row(label, desc, `
    <div class="color-pick-row">
      <input class="color-inp" type="color" id="cp-${key}" value="${escH(val)}"
             data-act="meta.color" data-key="${key}"/>
      <input class="text-inp text-mono" id="ct-${key}" style="width:110px" value="${escH(val)}"
             data-act="meta.colorHex" data-key="${key}"/>
    </div>`);
}

function renderSettings() {
  const m = L.meta;

  // ── 1. כללי ──
  const sponsors = (m.sponsorLogos || []).map((l, i) => `
    <div class="sprow">
      <div class="sp-thumb">${l.url ? `<img src="${escH(l.url)}" style="max-width:100%;max-height:100%;object-fit:contain"/>` : '—'}</div>
      <input class="text-inp" style="flex:1" value="${escH(l.url || '')}" placeholder="כתובת תמונה"
             data-act="sponsor.url" data-i="${i}"/>
      <input class="text-inp" style="width:120px" value="${escH(l.alt || '')}" placeholder="שם"
             data-act="sponsor.alt" data-i="${i}"/>
      <button class="team-del" data-act="sponsor.del" data-i="${i}">×</button>
    </div>`).join('');

  const general = `
    ${row('שם הליגה', '', `<input class="text-inp" style="width:260px" value="${escH(m.name)}" data-act="meta.name"/>`)}
    ${row('לוגו', 'כתובת תמונה. רצוי PNG שקוף.', `
      <input class="text-inp" style="width:260px" value="${escH(m.logoUrl)}" placeholder="https://…" data-act="meta.logoUrl"/>
      ${m.logoUrl ? `<img src="${escH(m.logoUrl)}" class="logo-prev-img" alt="" onerror="this.style.display='none'"/>` : ''}`)}
    ${colorRow('primaryColor',   'צבע ראשי',   'כל שאר הצבעים באתר נגזרים ממנו אוטומטית, עם ניגודיות WCAG מובטחת.')}
    ${colorRow('secondaryColor', 'צבע משני',   '')}
    ${colorRow('loadingColor',   'צבע מסך טעינה', 'ורוד.')}
    ${row('פונט', 'שלושתם תומכים בעברית.', `
      <select class="text-inp" style="width:150px" data-act="meta.font">
        ${FONTS.map(f => `<option value="${f}"${m.font === f ? ' selected' : ''}>${f}</option>`).join('')}
      </select>`)}
    <div class="sett-row" style="display:block">
      <span class="sett-name">ספונסרים</span>
      ${sponsors || '<div class="sett-empty-note">אין ספונסרים.</div>'}
      <div class="sett-add-row"><button class="add-cat-btn" data-act="sponsor.add">+ ספונסר</button></div>
    </div>`;

  // ── 2. ליגות ──
  const STAGES = [
    ['regular', 'ליגה סדירה'], ['sf', 'חצי גמר'],
    ['third', 'מקום 3–4'],     ['final', 'גמר']
  ];
  const leagues = L.categories.map(c => {
    const f = L.formats[c.id] || {};
    const fields = STAGES.map(([k, label]) => {
      const x = f[k] || {};
      return `
      <div class="cat-sett-field">
        <span class="cat-sett-label">${escH(label)}</span>
        <div class="cat-sett-ctrl fmt-ctrl">
          <select class="text-inp" data-act="fmt.sets" data-cat="${escH(c.id)}" data-stage="${k}">
            <option value="1"${x.sets === 1 ? ' selected' : ''}>מערכה אחת</option>
            <option value="3"${x.sets === 3 ? ' selected' : ''}>הטוב מ-3</option>
          </select>
          <label class="fmt-lbl">עד<input class="text-inp fmt-num" type="number" min="5" max="40"
            value="${x.to ?? ''}" data-act="fmt.to" data-cat="${escH(c.id)}" data-stage="${k}"/></label>
          ${x.sets === 3 ? `<label class="fmt-lbl">שלישית<input class="text-inp fmt-num" type="number" min="5" max="40"
            value="${x.third ?? ''}" data-act="fmt.third" data-cat="${escH(c.id)}" data-stage="${k}"/></label>` : ''}
          <label class="fmt-lbl">תקרה<input class="text-inp fmt-num" type="number" min="0" max="60"
            value="${x.cap ?? ''}" placeholder="ללא" data-act="fmt.cap" data-cat="${escH(c.id)}" data-stage="${k}"/></label>
        </div>
      </div>`;
    }).join('');

    return `<div class="cat-item">
      <div class="cat-item-head">
        <input class="text-inp cat-item-name-inp" value="${escH(c.name)}" data-act="cat.name" data-cat="${escH(c.id)}"/>
        <select class="text-inp" style="width:110px" data-act="cat.rr" data-cat="${escH(c.id)}">
          <option value="1"${c.rr === 1 ? ' selected' : ''}>סיבוב יחיד</option>
          <option value="2"${c.rr === 2 ? ' selected' : ''}>סיבוב כפול</option>
        </select>
      </div>
      <div class="cat-settings-grid">${fields}</div>
    </div>`;
  }).join('');

  const leaguesNote = `<div class="info-box" style="margin-bottom:12px">
    תקרה ריקה = <strong>ללא תקרה</strong>. כך מוגדר חצי הגמר של ליגה שנייה —
    מערכה עד 21 בהפרש 2 בלי גג. כל השאר: תקרה 25.
  </div>`;

  // ── 3. רשתות ──
  const nets = (m.nets || []).map((n, i) => row('', '', `
    <div class="color-pick-row" style="width:100%">
      <input class="color-inp" type="color" id="cp-net${i}" value="${escH(n.color)}"
             data-act="net.color" data-i="${i}"/>
      <input class="text-inp text-mono" id="ct-net${i}" style="width:110px" value="${escH(n.color)}"
             data-act="net.colorHex" data-i="${i}"/>
      <input class="text-inp" style="flex:1" value="${escH(n.name)}" placeholder="שם הרשת"
             data-act="net.name" data-i="${i}"/>
      <span class="net-chip" style="background:${escH(n.color)};color:${onColor(n.color)}">${escH(n.name)}</span>
    </div>`)).join('');

  const netsNote = `<div class="info-box" style="margin-bottom:12px">
    ארבעת קודי הצבע הם פלטת פוצ׳ילינה (Pantone 807 · 809 · 2173 והכהה).
    צבע הטקסט על כל צ׳יפ מחושב אוטומטית כדי להישאר קריא.
  </div>`;

  // ── 4. ימים ──
  const days = (m.days || []).map((d, i) => `
    <div class="cat-item">
      <div class="cat-item-head">
        <input class="text-inp" style="flex:1" value="${escH(d.label)}" data-act="day.label" data-i="${i}"/>
        <label class="toggle-switch" title="קובע אם היום מוצג לשחקניות או מוסתר">
          <input type="checkbox"${d.published ? ' checked' : ''} data-act="day.published" data-i="${i}"/>
          <span class="toggle-slider"></span>
          <span class="toggle-txt">${d.published ? 'מוצג לשחקניות' : 'מוסתר משחקניות'}</span>
        </label>
      </div>
      <div class="cat-settings-grid">
        <div class="cat-sett-field"><span class="cat-sett-label">תאריך</span>
          <input class="text-inp" type="date" value="${escH(d.date || '')}" data-act="day.date" data-i="${i}"/></div>
        <div class="cat-sett-field"><span class="cat-sett-label">שעת התחלה</span>
          <input class="text-inp" type="time" value="${escH(d.startTime)}" data-act="day.startTime" data-i="${i}"/></div>
        <div class="cat-sett-field"><span class="cat-sett-label">אורך סלוט (דק׳)</span>
          <input class="text-inp" type="number" min="5" max="60" value="${d.slotMin}" data-act="day.slotMin" data-i="${i}"/></div>
        <div class="cat-sett-field"><span class="cat-sett-label">מספר סלוטים</span>
          <input class="text-inp" type="number" min="1" max="40" value="${d.slots}" data-act="day.slots" data-i="${i}"/></div>
        <div class="cat-sett-field" style="grid-column:1/-1"><span class="cat-sett-label">חוף</span>
          <input class="text-inp" value="${escH(d.beach || '')}" data-act="day.beach" data-i="${i}"/></div>
        <div class="cat-sett-field" style="grid-column:1/-1"><span class="cat-sett-label">רשתות פעילות</span>
          <div class="net-toggles">${(m.nets || []).map(n => `
            <label class="net-toggle">
              <input type="checkbox"${(d.netIds || []).includes(n.id) ? ' checked' : ''}
                     data-act="day.net" data-i="${i}" data-net="${n.id}"/>
              <span class="net-chip" style="background:${escH(n.color)};color:${onColor(n.color)}">${escH(n.name)}</span>
            </label>`).join('')}</div></div>
        <div class="cat-sett-field" style="grid-column:1/-1"><span class="cat-sett-label">מגרש זמין עד שעה (למשל אם אין תאורה — ריק = בלי הגבלה)</span>
          <div class="net-cuts">${(d.netIds || []).slice().sort((a, b) => a - b).map(netId => {
            const n = (m.nets || []).find(x => x.id === netId);
            const cur = (L.blocks || []).find(b => b.kind === 'netcut' && b.day === d.id && b.net === netId)?.until || '';
            return `<label class="net-cut-row"><span class="net-cut-name">${escH(n?.name || netId)}</span>
              <input class="text-inp" type="time" value="${escH(cur)}" data-act="board.netCutSet" data-day="${escH(d.id)}" data-net="${netId}"/></label>`;
          }).join('')}</div></div>
      </div>
      <div class="day-readout">
        <span>חלון <b class="num">${escH(d.startTime)}–${escH(dayEndTime(d))}</b></span>
        <span>משך <b class="num">${Math.floor(d.slots * d.slotMin / 60)}:${String(d.slots * d.slotMin % 60).padStart(2, '0')}</b></span>
        <span>תאים <b class="num">${dayCapacity(d)}</b></span>
      </div>
    </div>`).join('');

  // ── 5. שוברי שוויון ──
  const tie = `<div class="info-box" style="margin:0">
    נקודות ← הפרש ← מפגש ישיר ← מיני־ליגה.
    <strong>נעול לפי התקנון, אינו ניתן לשינוי.</strong>
  </div>`;

  // ── 6. גישה ופעולות ──
  const access = `
    ${!m.managerPasswordHash ? `<div class="info-box scaffold-note">
      ⚠️ <strong>לא הוגדרה סיסמת מאסטר</strong> — כל מי שמגיעה לכתובת רואה הכל.
    </div>` : ''}
    ${row('סיסמת אדמין', 'הזנת תוצאות וסימון טכני בלבד.',
      `<input class="text-inp" type="password" style="width:200px" placeholder="${m.adminPasswordHash ? '•••••• (מוגדרת)' : 'לא מוגדרת'}" data-act="pw.admin"/>`)}
    ${row('סיסמת מאסטר', 'גישה מלאה: לוח הגרירה, פרסום, קבוצות והגדרות.',
      `<input class="text-inp" type="password" style="width:200px" placeholder="${m.managerPasswordHash ? '•••••• (מוגדרת)' : 'לא מוגדרת'}" data-act="pw.manager"/>`)}
    ${row('הרמה הנוכחית', 'שדה ריק מוחק את הסיסמה ומחזיר את האתר למצב פתוח.',
      `<span class="status-badge ${realRole() === 2 ? 'badge-approved' : realRole() === 1 ? 'badge-pending' : 'badge-rejected'}"
        >${realRole() === 2 ? 'מאסטר' : realRole() === 1 ? 'אדמין' : 'ציבור'}</span>`)}
    <div class="info-box" style="margin:12px 0 0">
      ההרשאה נאכפת בדפדפן בלבד. מי שיודעת את מזהה הליגה יכולה לקרוא את
      המסמך הגולמי.
    </div>`;

  return `
  ${section('general',  '1 · כללי',           general)}
  ${section('leagues',  '2 · ליגות',          leaguesNote + leagues)}
  ${section('nets',     '3 · רשתות',          netsNote + nets)}
  ${section('days',     '4 · ימים',           days)}
  ${section('tie',      '5 · שוברי שוויון',   tie)}
  ${section('access',   '6 · גישה',           access)}`;
}

function renderStatus() {
  const m = L.meta;
  const teams = Object.values(L.roster).reduce((n, arr) => n + arr.length, 0);

  const netChips = m.nets.map(n =>
    `<span class="net-chip" style="background:${escH(n.color)};color:${onColor(n.color)}">${escH(n.name)}</span>`
  ).join('');

  const dayRows = m.days.map(d => {
    const cap = dayCapacity(d);
    const used = L.games.filter(g => g.day === d.id && g.slot != null).length
               + L.blocks.filter(b => b.day === d.id).length;
    return `<tr>
      <td>${escH(d.label)}</td>
      <td>${d.date ? escH(d.date) : '<em>טרם נקבע</em>'}</td>
      <td class="num">${escH(d.startTime)}–${escH(dayEndTime(d))}</td>
      <td class="num">${d.slots} × ${d.slotMin}′</td>
      <td class="num">${used} / ${cap}</td>
      <td>${d.published ? '<span class="status-badge badge-approved">מפורסם</span>'
                        : '<span class="status-badge badge-pending">מוסתר</span>'}</td>
    </tr>`;
  }).join('');

  const catRows = L.categories.map(c => {
    const f = L.formats[c.id] || {};
    const fmt = x => !x ? '—'
      : x.sets > 1 ? `הטוב מ-${x.sets} · ${x.to}/${x.to}/${x.third}`
      : `מערכה עד ${x.to}${x.cap ? ` (תקרה ${x.cap})` : ' · ללא תקרה'}`;
    return `<tr>
      <td>${escH(c.name)}</td>
      <td class="num">${(L.roster[c.id] || []).length}</td>
      <td class="num">${c.rr === 2 ? 'כפול' : 'יחיד'}</td>
      <td>${fmt(f.regular)}</td>
      <td>${fmt(f.sf)}</td>
      <td>${fmt(f.final)}</td>
    </tr>`;
  }).join('');

  const day1 = m.days[0];
  const slotList = Array.from({ length: day1.slots }, (_, i) =>
    `<span class="slot">${i + 1}<b>${slotTime(day1, i + 1)}</b></span>`).join('');

  return `
  <div class="sett-section">
    <div class="sett-section-title">מצב המערכת</div>
    <span class="sett-desc">העמוד הזה קיים כדי
       שאפשר יהיה לראות שהמודל נטען נכון ושהסנכרון עובד — הוא לא חלק מהאתר הסופי.</span>
    <dl class="kv" style="margin-top:14px">
      <dt>מזהה הליגה</dt><dd><code class="num">tournaments/${escH(LEAGUE_ID)}</code></dd>
      <dt>קבוצות רשומות</dt><dd>${teams}</dd>
      <dt>משחקים</dt><dd>${L.games.length} <span class="muted">— המתזמן נבנה בשלב 3</span></dd>
      <dt>חסימות בלוז</dt><dd>${L.blocks.length}</dd>
      <dt>שוברי שוויון</dt><dd>${m.tieBreak.join(' ← ')} <span class="muted">— נעול לפי 3.10</span></dd>
      <dt>ניקוד</dt><dd>ניצחון ${m.scoring.win} · הפסד ${m.scoring.loss} · טכני ${m.scoring.techLoss}
        · <strong>כוח עליון ${m.scoring.unfinished}</strong> <span class="muted">— 6.2, הערך היחיד שאינו שלם</span></dd>
    </dl>
  </div>

  <div class="sett-section">
    <div class="sett-section-title">רשתות</div>
    <div class="net-chips">${netChips}</div>
    <div class="info-box" style="margin-top:12px;margin-bottom:0">
      ארבע הרשתות בפלטת פוצ׳ילינה: ורוד (807 C) · צהוב (809 C) · כחול (2173 C) · כהה.
    </div>
  </div>

  <div class="sett-section">
    <div class="sett-section-title">ימים</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>מחזור</th><th>תאריך</th><th>חלון</th><th>סלוטים</th><th>תפוסה</th><th>מצב</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:12px">16 סלוטים × 20 דקות = 5:20.
      16 × 4 רשתות = 64 תאים.</span>
    <div class="slot-strip">${slotList}</div>
  </div>

  <div class="sett-section">
    <div class="sett-section-title">ליגות ופורמטים</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>ליגה</th><th>קבוצות</th><th>סיבובים</th><th>ליגה סדירה</th><th>חצי גמר</th><th>גמר</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table></div>
  </div>

  ${DEV ? `
  <div class="sett-section scaffold">
    <div class="sett-section-title">בדיקת סנכרון</div>
    <span class="sett-desc">שינוי השם נשמר ביציאה מהשדה (<code>onchange</code>, לא
       <code>oninput</code> — מלכודת 3). פתחי את העמוד בשני חלונות כדי לראות
       את השינוי עובר בלייב.</span>
    <input class="text-inp" id="dev-name" style="margin-top:10px" value="${escH(L.meta.name)}" data-act="dev.name"/>
  </div>` : ''}
  `;
}

// ============================================================================
// עמוד דירוג + הזנת תוצאות — §14 שלב 4
// ============================================================================

let standCat  = null;   // הליגה המוצגת
let standTeam = null;   // סינון למשחקי קבוצה אחת (§7.2)

// פונקציית רינדור עצמאית: תיבות ניקוד + תפריט טכני למשחק בודד. אין לה state
// ותלות בטאב — שלב 5 (לוז) יקרא לה. הזיהוי דרך data-id בלבד.
function renderGameEntry(g) {
  const r = g.result;
  const tech = r === 'tech_a' || r === 'tech_b' || r === 'both_absent' || r === 'unfinished';
  const fmt = L.formats[g.cat]?.regular || F_SET18;
  const { sa, sb } = techScores(g);

  const invalid = !tech && sa != null && sb != null &&
    !validSet(Math.max(sa, sb), Math.min(sa, sb), fmt.to, fmt.cap);

  const nameA = TEAM_NAME(g.a), nameB = TEAM_NAME(g.b);
  const winA = (r === 'ok' && sa > sb) || r === 'tech_b';
  const winB = (r === 'ok' && sb > sa) || r === 'tech_a';

  const box = (side, val) => `<input class="text-inp res-inp" type="number" min="0" max="60"
      id="ri-${escH(g.id)}-${side}" value="${val ?? ''}"
      data-act="res.score" data-id="${escH(g.id)}" data-side="${side}"${tech ? ' disabled' : ''}/>`;

  const badge =
      r === 'tech_a' || r === 'tech_b' ? `<span class="status-badge badge-rejected">${isNoShowLoser(g) ? 'היעדרות' : 'טכני'}</span>`
    : r === 'both_absent'              ? `<span class="status-badge badge-rejected">שתיהן נעדרו</span>`
    : r === 'unfinished'               ? `<span class="status-badge badge-pending">לא הסתיים</span>`
    : r === 'ok'                       ? `<span class="status-badge badge-approved">הסתיים</span>`
    : '';

  const menu = `<details class="tech-menu">
    <summary title="הפסד טכני / היעדרות / כוח עליון">ט</summary>
    <div class="tech-pop">
      <button data-act="res.tech" data-id="${escH(g.id)}" data-side="a">${escH(nameA)} לא הגיעה</button>
      <button data-act="res.tech" data-id="${escH(g.id)}" data-side="b">${escH(nameB)} לא הגיעה</button>
      <button data-act="res.tech" data-id="${escH(g.id)}" data-side="both">שתיהן לא הגיעו</button>
      <button data-act="res.tech" data-id="${escH(g.id)}" data-side="unf">לא הסתיים (כוח עליון)</button>
      ${r !== 'pending' ? `<button class="tp-clear" data-act="res.tech" data-id="${escH(g.id)}" data-side="clear">נקה תוצאה</button>` : ''}
    </div>
  </details>`;

  return `<div class="res-row${invalid ? ' invalid' : ''}${tech ? ' tech' : ''}">
    <span class="res-team${winA ? ' win' : ''}">${escH(nameA)}</span>
    <span class="res-score">${box('sa', sa)}<b>:</b>${box('sb', sb)}</span>
    <span class="res-team${winB ? ' win' : ''}">${escH(nameB)}</span>
    <span class="res-meta">${badge}${menu}</span>
    ${invalid ? `<span class="score-err">תוצאה לא חוקית — עד ${fmt.to}${fmt.cap ? `, תקרה ${fmt.cap}` : ', ללא תקרה'}, הפרש 2</span>` : ''}
  </div>`;
}

function renderStandings() {
  const cats = L.categories.filter(c => (L.roster[c.id] || []).length >= 2);
  if (!cats.length) return `<div class="sett-section empty">
    <h3>${escH(t('stand.emptyH'))}</h3>
    <p>${escH(t('stand.emptyP'))}</p>
  </div>`;

  if (!standCat || !cats.find(c => c.id === standCat)) standCat = cats[0].id;

  const nav = `<div class="court-filter">${cats.map(c =>
    `<button class="cf-btn${c.id === standCat ? ' on' : ''}" data-act="stand.cat" data-cat="${escH(c.id)}">${escH(tData(c.name))}</button>`
  ).join('')}</div>`;

  const { ranked, alerts } = rankStandings(standCat);

  const alertBox = alerts.map(a =>
    `<div class="sched-msg warn tie-alert">⚠ ${escH(t('stand.tie', {
        n: a.size,
        places: a.start === a.end ? a.start : a.start + '–' + a.end
      }))}${a.touchesF4 ? escH(t('stand.tieF4')) : ''}.</div>`).join('');

  // הזנת התוצאות עברה לטאב "לוז" (שלב 5, §8) — כאן נשארת הטבלה החיה,
  // ומשחקי הקבוצה שנלחצה נפתחים במגירה מתחת לשורה שלה (§7.2).
  return nav + standTable(ranked) + alertBox;
}

// §7.2 — "לחיצה על קבוצה פותחת את כל משחקיה". המגירה נפתחת **מתחת לשורה**
// ולא ככרטיס בתחתית העמוד: כך העין לא מאבדת את הקבוצה שנלחצה, וזה גם מה
// שהמוקאפ המאושר עושה. רק ימים שהצופה רשאית לראות — אצל שחקנית לוז של
// מחזור מוסתר לא ידלוף דרך טבלת הדירוג.
function teamDrawer(teamId, cols, qual) {
  const ok = (L.meta.days || []).filter(dayVisible);
  const gs = (L.games || []).filter(g => (g.a === teamId || g.b === teamId));

  const rounds = ok.map(d => {
    const list = gs.filter(g => g.day === d.id).sort((a, b) => (a.slot || 0) - (b.slot || 0));
    if (!list.length) return '';
    return `<section class="rnd">
      <h4 class="rnd__t">${escH(tData(d.label))}</h4>
      <ol class="rnd__games">${list.map(g => drawerGame(g, teamId)).join('')}</ol>
    </section>`;
  }).join('');

  // ‎.winner‎ גם על המגירה: מסגרת הפיינל פור חייבת להימשך דרכה, אחרת פתיחת
  // שורה בתוך הארבע הראשונות שוברת את המסגרת לשניים.
  // ⚠️ ‎gdrawer‎ ולא ‎drawer‎ — ‎.drawer‎ כבר תפוס במגירת הצד של לוח הגרירה
  // (‎width:210px; display:flex‎), וזה היה מוציא את התא ממודל הטבלה ומאיין
  // את ה-colspan.
  return `<tr class="gdrawer${qual ? ' winner' : ''}"><td colspan="${cols}">
    <div class="rounds">${rounds ||
      `<p class="foot">${escH(t('drawer.none'))}</p>`}</div>
  </td></tr>`;
}

// לוח תוצאות של שתי שורות — שורה לקבוצה, הניקוד שלה בקצה השורה שלה.
// הקבוצה שנפתחה תמיד למעלה, כדי שאפשר יהיה לסרוק עמודה אחת של תוצאות.
function drawerGame(g, teamId) {
  const { sa, sb } = techScores(g);
  const flip = g.b === teamId;
  const done = g.result !== 'pending' && g.result !== 'cancelled' && g.result !== 'unfinished';
  const side = (id, sc, win) => `<span class="side${win ? ' is-win' : ''}">
      <span class="side__team">${escH(TEAM_NAME(id))}</span>
      <span class="side__sc">${done ? (sc ?? 0) : '·'}</span>
    </span>`;
  const [ia, ib] = flip ? [g.b, g.a] : [g.a, g.b];
  const [ca, cb] = flip ? [sb, sa] : [sa, sb];
  return `<li class="game${done ? '' : ' is-pending'}">
    ${side(ia, ca, done && (ca ?? 0) > (cb ?? 0))}
    ${side(ib, cb, done && (cb ?? 0) > (ca ?? 0))}
  </li>`;
}

function standTable(ranked) {
  // מחלקות העמודות (‎c-*‎) הן החוזה עם league.css: הן נותנות לעמודת המיון את
  // הגוון שלה, להפסד הטכני את התגית, ולעמודות המשניות להיעלם בטלפון — בלי
  // להישען על nth-child, שנשבר בשקט אם סדר העמודות ישתנה.
  //
  // סרגל ההפרש מנורמל למקסימום המוחלט בטבלה, כך שהעמודה נקראת כהשוואה בין
  // הקבוצות ולא כערך מוחלט חסר הקשר.
  const maxAbs = Math.max(1, ...ranked.map(({ row }) => Math.abs(row.diff)));
  const rows = ranked.map(({ row, rank, tied }) => {
    const dc = row.diff > 0 ? 'diff-pos' : row.diff < 0 ? 'diff-neg' : 'diff-zero';
    const sign = row.diff > 0 ? '+' : '';
    const bar = `<span class="diffbar" aria-hidden="true">${row.diff
      ? `<i class="${row.diff > 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(row.diff) / maxAbs * 50)}%"></i>`
      : ''}</span>`;
    const open = standTeam === row.id;
    return `<tr class="stand-row${rank <= 4 ? ' winner' : ''}${open ? ' sel' : ''}"
        data-act="stand.team" data-id="${escH(row.id)}" tabindex="0" role="button"
        aria-expanded="${open}">
      <td class="num c-rank">${rank}${tied ? `<span class="tie-mark" title="${escH(t('stand.tieT'))}">=</span>` : ''}</td>
      <td class="stand-name c-team">${escH(row.name)}</td>
      <td class="num c-played">${row.played}</td>
      <td class="num">${row.wins}</td>
      <td class="num">${row.losses}</td>
      <td class="num c-pen">${row.tech ? `<span class="pen pen-tech">${row.tech}</span>` : ''}</td>
      <td class="num c-pen">${row.noshow ? `<span class="pen pen-abs">${row.noshow}</span>` : ''}</td>
      <td class="num c-pts"><b class="stand-pts">${fmtPts(row.pts)}</b></td>
      <td class="num c-opt">${row.pf}</td>
      <td class="num c-opt">${row.pa}</td>
      <td class="num c-diff"><span class="diffwrap">${bar}<span class="diffnum ${dc}">${sign}${row.diff}</span></span></td>
    </tr>${open ? teamDrawer(row.id, 11, rank <= 4) : ''}`;
  }).join('');

  return `<div class="sett-section">
    <div class="tscroll"><table class="stbl stand-tbl">
      <thead><tr><th class="c-rank">${escH(t('col.rank'))}</th>
        <th class="c-team">${escH(t('col.team'))}</th>
        <th class="c-played">${escH(t('col.played'))}</th>
        <th>${escH(t('col.wins'))}</th><th>${escH(t('col.losses'))}</th>
        <th class="c-pen">${escH(t('col.tech'))}</th><th class="c-pen">${escH(t('col.abs'))}</th>
        <th class="c-pts">${escH(t('col.pts'))}</th>
        <th class="c-opt">${escH(t('col.pf'))}</th><th class="c-opt">${escH(t('col.pa'))}</th>
        <th class="c-diff">${escH(t('col.diff'))}</th></tr></thead>
      <!-- שורת אוויר: מפרידה את הקו הכהה של כותרות העמודות ממסגרת הפיינל
           פור, שאחרת שתיהן נצמדות לאותם 2px (כמו ‎.spacer‎ במוקאפ). -->
      <tbody class="spacer" aria-hidden="true"><tr><td colspan="11"></td></tr></tbody>
      <tbody>${rows}</tbody>
    </table></div>
    <!-- מה שהעמוד כבר מראה לא נכתב שוב: המסגרת הצהובה אומרת "1–4 מעפילות",
         והחץ בשורה אומר "לחיצה פותחת משחקים". נשאר סדר השוברים בלבד. -->
  </div>`;
}

// ============================================================================
// לוז — הציבורי (§7.2) והמאסטר (§8.5 · §8.4)
// ============================================================================
//
// שני מסכים שונים על אותם נתונים: המאסטר מקבלת את לוח הגרירה של שלב 5 עם
// שני פאנלים מעליו (פרסום · נוכחות), וכל השאר מקבלות רשימה קריאה של הימים
// המפורסמים בלבד. הרשימה היא גם התצוגה המקדימה — אין שני מימושים.

let pubDay = null;   // היום המוצג בלוז הציבורי
let attDay = null;   // היום שפאנל הנוכחות פתוח עליו

// §7.2 — "ושדה החיפוש זוכר את עצמו". זה כל מה שנשאר מעמוד "הקבוצה שלי":
// מי שחיפשה פעם אחת לא מקלידה שוב לעולם. localStorage ולא sessionStorage —
// הזיכרון אמור לשרוד סגירת דפדפן בין מחזור למחזור.
const SEARCH_KEY = 'futilina-search:' + LEAGUE_ID;
let pubQuery = (() => { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch (_) { return ''; } })();
function setQuery(v) {
  pubQuery = v;
  try { v ? localStorage.setItem(SEARCH_KEY, v) : localStorage.removeItem(SEARCH_KEY); } catch (_) {}
}

// שורת משחק אחת לקריאה (לא להזנה). אותה שורה משמשת גם ברשימת משחקי הקבוצה
// שמתחת לטבלת הדירוג (§7.2).
function pubGameRow(g, opts = {}) {
  const day = (L.meta.days || []).find(d => d.id === g.day);
  const color = NET_COLOR(g.net);
  const { sa, sb } = techScores(g);
  const done = g.result !== 'pending' && g.result !== 'cancelled';
  // תוצאה מוכרעת → הצד המנצח מודגש והמספר שלו בכחול (שפת ‎.side.is-win‎
  // במוקאפ). "לא הסתיים" ו"נגד" אינם הכרעה ולכן אין בהם מנצחת.
  const scored = done && g.result !== 'unfinished';
  const wa = scored && (sa ?? 0) > (sb ?? 0);
  const wb = scored && (sb ?? 0) > (sa ?? 0);
  const score = g.result === 'unfinished'
    ? `<span class="pub-score muted">${escH(t('sched.unfin'))}</span>`
    : done
      ? `<span class="pub-score"><b class="num${wa ? ' win' : ''}">${sa ?? 0}</b><i>:</i><b class="num${wb ? ' win' : ''}">${sb ?? 0}</b></span>`
      : `<span class="pub-score pub-vs">${escH(t('sched.vs'))}</span>`;
  const search = `${TEAM_NAME(g.a)} ${TEAM_NAME(g.b)}`.toLowerCase();
  // צבע המגרש עובר כ-custom property ולא כרקע: ב-league.css הוא נישא על
  // השפה המובילה של הכרטיס (‎.mt‎ במוקאפ), ושם המגרש נשאר תווית קריאה.
  return `<div class="pub-game" data-s="${escH(search)}" style="--net:${escH(color)}">
    <span class="pub-net">${escH(tData(NET_NAME(g.net)))}</span>
    ${opts.withTime && day ? `<span class="pub-when num">${escH(slotTime(day, g.slot))}</span>` : ''}
    ${opts.withDay ? `<span class="pub-when">${escH(tData(dayLabel(g.day)))}</span>` : ''}
    <span class="pub-team${wa ? ' win' : ''}">${escH(TEAM_NAME(g.a))}</span>
    ${score}
    <span class="pub-team${wb ? ' win' : ''}">${escH(TEAM_NAME(g.b))}</span>
    <span class="pub-cat">${escH(tData(CAT_NAME(g.cat)))}</span>
  </div>`;
}

function renderPublicSchedule() {
  const days = schedDaysFor();
  if (!days.length) return `<div class="sett-section empty">
    <h3>${escH(t('sched.emptyH'))}</h3>
    <p>${escH(t('sched.emptyP'))}</p>
  </div>`;

  if (!pubDay || !days.some(d => d.id === pubDay)) pubDay = defaultDayId(days);
  const day = days.find(d => d.id === pubDay) || days[0];

  const games = (L.games || [])
    .filter(g => g.day === day.id && g.slot && g.net)
    .sort((a, b) => (a.slot - b.slot) || (a.net - b.net));

  const bySlot = new Map();
  for (const g of games) { if (!bySlot.has(g.slot)) bySlot.set(g.slot, []); bySlot.get(g.slot).push(g); }

  const picker = days.length > 1 ? `<div class="day-picker">${days.map(d =>
    `<button class="filter-btn${d.id === day.id ? ' on' : ''}" data-act="pub.day" data-day="${escH(d.id)}"
      >${escH(tData(d.label))}${d.date ? ` <span class="num">${fmtDate(d.date)}</span>` : ''}</button>`).join('')}</div>` : '';

  const head = `<div class="pub-head">
    <h3>${escH(tData(day.label))}${day.date ? ` <span class="num">${escH(fmtDate(day.date))}</span>` : ''}</h3>
    <span class="muted">${escH(tData(day.beach || ''))} · ${escH(t('sched.startsAt'))}<b class="num">${escH(day.startTime)}</b></span>
  </div>`;

  const search = `<div class="pub-search">
    <input class="text-inp" id="pub-search" type="search" placeholder="${escH(t('sched.search'))}"
           value="${escH(pubQuery)}"/>
    ${pubQuery ? `<button class="team-del" data-act="pub.clearSearch" title="${escH(t('sched.clear'))}">×</button>` : ''}
    <span class="team-counter" id="pub-count"></span>
  </div>`;

  const list = [...bySlot.entries()].map(([slot, gs]) => `
    <div class="pub-slot">
      <div class="pub-time num">${escH(slotTime(day, slot))}</div>
      <div class="pub-games">${gs.map(g => pubGameRow(g)).join('')}</div>
    </div>`).join('');

  // הזנת תוצאות = אדמין ומעלה (§7.1). אותו רכיב של שלב 4, בלי עותק שני.
  const entry = R() >= 1 ? `<details class="results-panel" open>
    <summary class="sett-section-title">הזנת תוצאות · ${escH(tData(day.label))}
      <span class="muted">${games.length}</span></summary>
    <div class="results-body">${games.map(g => renderGameEntry(g)).join('')}</div>
  </details>` : '';

  setTimeout(pubFilter, 0);   // מחיל את החיפוש הזכור מיד אחרי שה-HTML נכנס ל-DOM
  return `<div class="sett-section pub-sched">
    ${picker}${head}${search}
    ${list || `<div class="empty">${escH(t('sched.noGames'))}</div>`}
  </div>${entry}`;
}

// סינון החיפוש בלי רינדור מחדש — הקלדה לא יכולה לאבד את הפוקוס בשדה
// (מלכודת 3 בגרסתה החריפה: כאן זה שדה שמסנן את עצמו).
function pubFilter() {
  const q = pubQuery.trim().toLowerCase();
  let n = 0;
  document.querySelectorAll('.pub-game').forEach(el => {
    const hit = !q || (el.dataset.s || '').includes(q);
    el.classList.toggle('hide', !hit);
    if (hit) n++;
  });
  document.querySelectorAll('.pub-slot').forEach(row =>
    row.classList.toggle('hide', !row.querySelector('.pub-game:not(.hide)')));
  const c = document.getElementById('pub-count');
  if (c) {
    c.textContent = !q ? '' : n ? t('sched.found', { n }) : t('sched.notfound');
    c.classList.toggle('no', !!q && !n);
  }
}

// ── מסך המאסטר: שני פאנלים מקופלים מעל לוח הגרירה ─────────────────────────
// מקופלים במכוון — הלוח מותח את עצמו לגובה הזמין (fitGrid), וכל פאנל פתוח
// גוזל ממנו. הסיכום בשורת הכותרת נותן את המידע בלי לפתוח.
function masterSchedule() {
  // שניהם סגורים = שורה אחת משותפת (‎.mpanels‎ מציב אותם זה לצד זה), פתוח =
  // שורה מלאה. ככה שני הפאנלים עולים ללוח ~45px של גובה במקום 90.
  // שלושה פאנלים: פרסום (§8.5) · נוכחות (§8.4) · דחיסה חיה (§8.7). הפאנל
  // החי אינו מוצג כשאין לוז — אין מה להקדים.
  return `<div class="mpanels">${publishBar()}${attPanel()}${livePanel()}</div>` + Board.render();
}

// §8.5 — מתג לכל יום, מתג "הצג מחזורים שהסתיימו", וכפתור התצוגה המקדימה.
function publishBar() {
  const days = (L.meta.days || []).filter(d =>
    d.id !== 'ff' && (L.games || []).some(g => g.day === d.id && g.slot));
  const isShown = d => !!d.published;
  const shown = days.filter(isShown).length;
  const ff = ffDay();
  const summary = (!days.length ? 'פרסום — אין עדיין לוז'
    : shown ? `פרסום · <b>${shown}</b> מתוך ${days.length} מחזורים מוצגים לשחקניות`
            : `פרסום · <b class="pub-none">אף מחזור אינו מוצג לשחקניות</b>`)
    + (ff ? ` · פיינל פור ${ff.published ? 'מוצג' : '<b class="pub-none">מוסתר</b>'}` : '');

  const chipOf = (d, extra) => `
    <button class="pub-chip${d.published ? ' on' : ''}" data-act="pub.toggle" data-day="${escH(d.id)}"
      title="${d.published ? 'מוצג — לחיצה מסתירה' : 'מוסתר — לחיצה מציגה'}">
      <span class="pub-chip-dot"></span>${escH(d.label)}${extra || ''}
    </button>`;

  const chips = days.map(d => chipOf(d, d.published && !isShown(d) ? '<span class="muted">(הסתיים)</span>' : ''))
    .join('') || (ff ? '' : '<span class="muted">צרי לוז בעמוד המתזמן.</span>');
  // §8.5 — הפיינל פור אינו משובץ לגריד ולכן אין לו לוז שיסמן אותו כאן; הצ׳יפ
  // שלו מפרסם את **הטאב** (הבראקט), ומשתמש באותה פעולה בדיוק.
  const ffChip = ff ? chipOf(ff, '<span class="muted">(הטאב)</span>') : '';

  return `<details class="sett-section mpanel pub-bar" id="sec-publish"${openSections.has('publish') ? ' open' : ''}>
    <summary class="sett-section-title">${summary}</summary>
    <div class="mpanel-body pub-bar-body">
      <div class="pub-chips">${chips}${ffChip}</div>
      <div class="pub-tools">
        <button class="cf-btn" data-act="pub.preview">👀 איך זה נראה לשחקניות</button>
      </div>
      <span class="sett-desc">כל עוד מחזור מוסתר אפשר לגרור אותו בשקט — השחקניות
        לא רואות אותו כלל. פרסום נכנס לתוקף מיד אצל כולן.
        <strong>פיינל פור</strong> מפרסם את הטאב כולו (הבראקט ומשחקי ההצלבה) —
        עד שהוא דלוק, הטאב לא קיים אצל אף אחת חוץ ממך.</span>
    </div>
  </details>`;
}

// §8.4 — שני דברים שונים באותה שורה: בקשה **מראש** (חלון זמן, אילוץ קשיח
// למתזמן) ומה שקרה **בפועל** ביום עצמו (הגיעה / נעדרה → הפסד טכני).
function attPanel() {
  const days = regularDays();
  if (!days.length) return '';
  if (!attDay || !days.some(d => d.id === attDay)) attDay = defaultDayId(days);
  const day  = days.find(d => d.id === attDay) || days[0];
  const av   = L.availability?.[day.id] || {};
  const att  = L.attendance?.[day.id]   || {};

  const teams = L.categories.flatMap(c =>
    (L.roster[c.id] || []).filter(t => t.active !== false).map(t => ({ t, c })));
  const reqN  = teams.filter(({ t }) => { const a = av[t.id]; return a && (a.notBefore || a.notAfter || a.note); }).length;
  const outN  = teams.filter(({ t }) => att[t.id] === 'noshow').length;

  const rows = teams.map(({ t, c }) => {
    const a = av[t.id] || {};
    const st = att[t.id] || '';
    const n = (L.games || []).filter(g => g.day === day.id && (g.a === t.id || g.b === t.id)).length;
    const inp = (act, type, val, ph, cls) =>
      `<input class="text-inp ${cls}" type="${type}" value="${escH(val || '')}"${ph ? ` placeholder="${escH(ph)}"` : ''}
        data-act="${act}" data-day="${escH(day.id)}" data-team="${escH(t.id)}"/>`;
    return `<tr class="att-row${st === 'noshow' ? ' out' : ''}">
      <td class="att-name">${escH(t.name || t.id)}
        <span class="muted">${escH(CAT_NAME(c.id))} · ${n} משחקים</span></td>
      <td>${inp('av.before', 'time', a.notBefore, '', 'att-time')}</td>
      <td>${inp('av.after',  'time', a.notAfter,  '', 'att-time')}</td>
      <td>${inp('av.note',   'text', a.note, 'סיבה (רשות)', 'att-note')}</td>
      <td class="att-mark">
        <button class="filter-btn${st === 'ok' ? ' on' : ''}" data-act="att.ok"
          data-day="${escH(day.id)}" data-team="${escH(t.id)}">הגיעה</button>
        <button class="filter-btn${st === 'noshow' ? ' on' : ''}" data-act="res.noshowDay"
          data-day="${escH(day.id)}" data-team="${escH(t.id)}">נעדרה</button>
      </td>
    </tr>`;
  }).join('');

  const summary = `נוכחות וזמינות · ${escH(day.label)}` +
    (reqN ? ` · <b>${reqN}</b> בקשות` : '') +
    (outN ? ` · <b class="pub-none">${outN} נעדרו</b>` : '');

  return `<details class="sett-section mpanel att-panel" id="sec-att"${openSections.has('att') ? ' open' : ''}>
    <summary class="sett-section-title">${summary}</summary>
    <div class="mpanel-body att-body">
      <div class="day-picker">${days.map(d =>
        `<button class="filter-btn${d.id === day.id ? ' on' : ''}" data-act="att.day" data-day="${escH(d.id)}"
          >${escH(d.label)}</button>`).join('')}</div>
      <div class="tscroll"><table class="stbl att-tbl">
        <thead><tr><th>קבוצה</th><th>מגיעה מ־</th><th>עוזבת ב־</th><th>הערה</th><th>ביום עצמו</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <span class="sett-desc">"מגיעה מ־" ו"עוזבת ב־" הן <strong>בקשות מראש</strong> —
        אילוץ קשיח שהמתזמן מכבד. אחרי שינוי כדאי "סדר מחדש" ליום הזה.
        "נעדרה" הוא מה שקרה <strong>בפועל</strong>: כל משחקיה במחזור נרשמים
        כהפסד טכני ${L.meta.scoring?.walkoverFor ?? 18}:${L.meta.scoring?.walkoverAgainst ?? 10}.</span>
    </div>
  </details>`;
}

// ============================================================================
// דחיסת לוז חיה — §8.7 (שלב 6ב)
// ============================================================================
//
// **עקרון-על נעול: לעולם לא אוטומטי.** המערכת מחשבת ומציעה; המאסטר לוחצת.
// שום משחק לא זז בלי לחיצה מפורשת, וגם אז רק אחרי שכל חוקי §6 נבדקו על
// השיבוץ **החדש** בפונקציית העלות עצמה (dayCost) ולא בהיוריסטיקה מקבילה.
//
// שלושת סוגי ההצעה של §8.7 נבדלים במה שזז, לא במנגנון (ראו liveKindOf):
//   הקדמה  — משחק בודד נמשך קדימה על **אותה רשת** שהתפנתה.
//   הזזה   — משחק בודד עובר לתא פנוי אחר, כולל מגרש אחר.
//   קבוצתית — משחק שלא יכול לזוז לבד גורר שרשרת: אריזה מחדש של היום
//             (generateSeason + onlyDays) שכל הקפואים בה נעולים.
//
// מה ש**לא** מוצע: כל מה שלא חוסך זמן לאף אחת. הרשימה היא הודעה אחת מרוכזת
// שהמנהלת פותחת כשנוח לה, ורשימה שמלאה במהלכים ניטרליים היא רשימה שלא נקראת.
//
// אין שדה חדש במודל מלבד meta.liveReschedule (§5 נעול): ההצעות מחושבות מחדש
// מהמצב בכל רינדור ואינן נשמרות.

const LIVE_PULL_OK_MIN = 40;   // משיכה קדימה מעבר לזה = אזהרה + אישור נוסף (ה-X של §8.7)
const LIVE_TOP         = 8;    // כמה הצעות מוצגות — הודעה אחת מרוכזת, לא רשימה אינסופית
// האריזה הקבוצתית היא המתזמן המלא על יום אחד. ברירות המחדל שלו (32 הרצות,
// 60ש) נכונות ליצירת לוז בערב שלפני, לא לכפתור שהמנהלת לוחצת באמצע טורניר:
// נמדד 28ש כשכל היום עוד לפניו. 6 הרצות + תקציב 8ש נותנות תשובה בזמן סביר,
// ובשעת האמת ממילא רוב היום כבר נעול והריצה קצרה. packDay מריץ תמיד לפחות 3.
const LIVE_RESTARTS    = 6;
const LIVE_BUDGET_MS   = 8000;

let liveDay      = null;   // היום שהפאנל פועל עליו
let liveNowStr   = '';     // דריסת "עכשיו" — ?dev=1 בלבד, כדי שאפשר יהיה לבדוק
let liveBusy     = false;  // האריזה הקבוצתית רצה
let liveCache    = null;   // { sig, list } — ההצעות הזולות, ממוחזרות בין רינדורים
let liveGroupRes = null;   // { sig, sug } — תוצאת החישוב הכבד האחרון

const liveOn = () => !!L.meta.liveReschedule;

// השעה שלפיה נקבע מה כבר התחיל. ?dev=1 מאפשר לדרוס אותה — בלי זה אי אפשר
// לבדוק את הפיצ׳ר אלא בערב משחקים אמיתי.
const liveNowLabel = () => (DEV && liveNowStr) ? liveNowStr
  : (() => { const t = new Date(); return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`; })();

// הסלוט שרץ **כרגע**. 0 = היום עוד לא התחיל; day.slots = הסתיים.
// התאריך מכריע לפני השעון: יום עתידי לא "רץ" ב-19:00 רק כי השעה 19:00.
function liveSlotNow(day) {
  const over = DEV && liveNowStr;
  if (!over) {
    const d = (L.meta.days || []).find(x => x.id === day.id);
    if (d?.date && d.date > todayISO()) return 0;
    if (d?.date && d.date < todayISO()) return day.slots;
  }
  const t = hhmmToMin(liveNowLabel()) - hhmmToMin(day.startTime);
  if (t < 0) return 0;
  return Math.min(day.slots, Math.floor(t / day.slotMin) + 1);
}

// מצב היום החי: ההקשר של §6, השיבוץ הנוכחי, הסלוט הרץ, ומי קפוא.
// **קפוא = לא זז**: נעול 📌, יש לו תוצאה (גמר), או שהסלוט שלו כבר התחיל.
function liveState(dayId) {
  const input = schedInput();
  const day = input.days.find(d => d.id === dayId);
  if (!day) return null;
  const dayGames = (L.games || []).filter(g => g.day === dayId);
  if (!dayGames.some(g => g.slot && g.net)) return null;

  const total = {};
  for (const g of (L.games || [])) { total[g.a] = (total[g.a] || 0) + 1; total[g.b] = (total[g.b] || 0) + 1; }
  const D = Math.max(1, input.days.length);
  const bounds = {};
  for (const [t, n] of Object.entries(total)) bounds[t] = { lo: Math.floor(n / D), hi: Math.ceil(n / D) };

  const ctx = buildDayContext(input, day, dayGames, bounds);
  const place = new Map();
  for (const g of dayGames) if (g.slot && g.net) place.set(g.key, { slot: g.slot, net: g.net });

  const nowSlot = liveSlotNow(day);
  const done = g => !!g.result && g.result !== 'pending';
  const frozen = new Set(dayGames
    .filter(g => !g.slot || !g.net || g.locked || done(g) || g.slot <= nowSlot)
    .map(g => g.key));

  return { input, day, dayGames, ctx, place, nowSlot, frozen, base: dayCost(place, ctx) };
}

// מפתח הפרה — לזיהוי מה **נוסף** אחרי ההזזה ומה כבר היה קודם
const violKey = v => `${v.kind}|${v.team || ''}|${v.slot || ''}|${v.net || ''}`;

// אילו הפרות רכות שווה להציג כאזהרה על הצעה. `emptyEarly` ו-`lateFinish`
// מכוונות החוצה במפורש: משחק שמוקדם **תמיד** משאיר חור אחריו, וזו בדיוק
// המטרה — להציג את זה כאזהרה היה הופך כל הצעה לאזהרה חסרת מידע. אותו שיקול
// ל-fairness/catReturn/span, שאינם אזהרות ב-§9.
const LIVE_WARN_KINDS = new Set(['backToBack', 'longWait', 'noReferee',
  'tooMany', 'tooFew', 'noGames', 'sharedPlayerAdjacent']);

// שם קבוצה במקום מזהה פנימי בטקסט של המתזמן — אותו טיפול כמו ב-violationList
const violText = t => String(t || '').replace(/\b([sl]\d?t\d+)\b/g, (_, id) => TEAM_NAME(id));

// אזהרות אנושיות להצעה (§8.7): מי אולי לא תגיע, ומשיכה אגרסיבית מדי.
//
// "טרם הגיעה" הוא אזהרה **רק** כשהיא נושאת מידע, ולכן שלושה סייגים: המחזור
// רץ · המשחק בכלל מוקדם · ואין שום עדות שהזוג על החוף. "עדות" היא משחק
// שכבר התחיל היום — ולא תוצאה שהוזנה, כי הזנת התוצאות מפגרת אחרי המציאות.
// בלי הסייגים האלה כל הצעה נשאה 20 שורות אזהרה, וזה שווה ערך לאפס אזהרות.
// שורה אחת לכל סוג, עם ספירה — לא שורה לכל קבוצה.
function liveWarns(st, teamIds, pullMin) {
  const att = L.attendance?.[st.day.id] || {};
  const onBeach = t => att[t] === 'ok' ||
    st.dayGames.some(g => (g.a === t || g.b === t) && g.slot && g.slot <= st.nowSlot);
  const gone = [], late = [], busy = [];
  for (const t of new Set(teamIds)) {
    if (att[t] === 'noshow') gone.push(t);
    else if (st.nowSlot && pullMin > 0 && !onBeach(t)) late.push(t);
    if (st.nowSlot && st.dayGames.some(g => g.slot === st.nowSlot && (g.a === t || g.b === t))) busy.push(t);
  }
  const line = (list, one, many) => !list.length ? ''
    : list.length === 1 ? `${TEAM_NAME(list[0])} ${one}` : `${list.length} קבוצות ${many}`;
  return [
    line(gone, 'סומנה כנעדרת', 'סומנו כנעדרות'),
    line(late, 'טרם הגיעה', 'טרם הגיעו'),
    line(busy, 'משחקת כרגע', 'משחקות כרגע'),
    pullMin > LIVE_PULL_OK_MIN ? `מוקדם ב-${pullMin} דק׳ — צריך זמן להתארגן` : ''
  ].filter(Boolean);
}

// שני סוגי ההצעה של משחק בודד, בדיוק כלשון §8.7: **הקדמה** היא משיכה קדימה
// "לרשת שהתפנתה" — אותה רשת, מוקדם יותר, והזוג נשאר על אותו מגרש; **הזזה**
// היא מעבר "למקום פנוי אחר בלוז" — גם המגרש משתנה. ההבחנה אינה קוסמטית:
// היא בדיוק מה שהמנהלת צריכה להגיד לזוג בקול רם.
const liveKindOf = (g, slot, net) => (slot < g.slot && net === g.net) ? 'advance' : 'move';

// הצעה אחת, בצורה שהטבלה יודעת להציג ו-live.apply יודע לבצע.
function liveSug(st, kind, moves, cost, pairSaved) {
  const endSaved = (st.base.lastSlot - cost.lastSlot) * st.day.slotMin;
  const seen = new Set((st.base.violations || []).map(violKey));
  const fresh = [...new Set((cost.violations || [])
    .filter(v => LIVE_WARN_KINDS.has(v.kind) && !seen.has(violKey(v)))
    .map(v => violText(v.text)))].slice(0, 3);
  const teams = moves.flatMap(m => { const g = findGame(m.id); return g ? [g.a, g.b] : []; });
  return {
    kind, moves, endSaved, pairSaved, teams, endSlot: cost.lastSlot,
    score: endSaved * 1000 + Math.max(0, pairSaved),
    warns: [...liveWarns(st, teams, pairSaved), ...fresh]
  };
}

// ── הצעות של משחק בודד (הקדמה / הזזה) ──
// לכל משחק שטרם התחיל נבדקים כל התאים הפנויים שאחרי הסלוט הרץ, ונשמרת
// **הטובה ביותר בלבד** — אחרת אותו משחק היה ממלא את הרשימה ב-12 וריאציות.
function liveSingles(st) {
  const { ctx, place, day, nowSlot, base } = st;
  const occupied = new Set();
  const teamAt = new Map();   // 'סלוט|קבוצה' → כמה משחקים
  for (const g of st.dayGames) {
    if (!g.slot || !g.net) continue;
    occupied.add(g.slot + '|' + g.net);
    for (const t of [g.a, g.b]) { const k = g.slot + '|' + t; teamAt.set(k, (teamAt.get(k) || 0) + 1); }
  }

  const out = [];
  for (const g of st.dayGames) {
    if (st.frozen.has(g.key)) continue;
    let best = null;
    for (let s = nowSlot + 1; s <= day.slots; s++) {
      for (const n of ctx.netIds) {
        if (s === g.slot && n === g.net) continue;
        if (occupied.has(s + '|' + n) || ctx.blocked.has(s + '|' + n)) continue;
        // מסנן זול לפני dayCost: קבוצה שכבר משחקת בסלוט הזה (בלי לספור את
        // המשחק עצמו, שיוצא מהתא). זה גם האילוץ הקשיח הראשון של §6.2.
        const self = g.slot === s ? 1 : 0;
        if ((teamAt.get(s + '|' + g.a) || 0) - self > 0) continue;
        if ((teamAt.get(s + '|' + g.b) || 0) - self > 0) continue;

        const cand = new Map(place);
        cand.set(g.key, { slot: s, net: n });
        const cost = dayCost(cand, ctx);
        if (cost.hard > base.hard) continue;   // אילוץ קשיח נשבר — לא מוצג כלל (§8.7)

        const pairSaved = (g.slot - s) * day.slotMin;
        const endSaved  = (base.lastSlot - cost.lastSlot) * day.slotMin;
        if (pairSaved <= 0 && endSaved <= 0) continue;   // לא חוסך זמן לאף אחת
        const score = endSaved * 1000 + Math.max(0, pairSaved);
        if (!best || score > best.score) best = { s, n, cost, pairSaved, score };
      }
    }
    if (best)
      out.push(liveSug(st, liveKindOf(g, best.s, best.n),
        [{ id: g.id, key: g.key, slot: best.s, net: best.n, from: { slot: g.slot, net: g.net } }],
        best.cost, best.pairSaved));
  }
  return out;
}

// ── ההצעה הקבוצתית ──
// ממחזר את המתזמן במלואו (§8.7 "מימוש"): אריזה מחדש של יום אחד בלבד
// (`onlyDays`), כשכל הקפואים נעולים. שני דברים שהמתזמן לא יודע לבד ולכן
// מוזרקים דרך הקלט הקיים שלו: (1) נעילה — `locked:true`; (2) "אסור לרדת מתחת
// לסלוט הרץ" — חלון זמינות `notBefore` לכל קבוצות היום, אילוץ קשיח שהוא כבר
// מכבד (availWindow). כך אין שינוי בחוזה של §6.
function liveGroup(st) {
  const { day, nowSlot } = st;
  const av = { ...(st.input.availability?.[day.id] || {}) };
  if (nowSlot >= 1) {
    const floor = slotTime(day, nowSlot + 1);
    const teams = new Set(st.dayGames.flatMap(g => [g.a, g.b]));
    for (const t of teams) {
      const cur = av[t] || {};
      av[t] = { ...cur, notBefore:
        cur.notBefore && hhmmToMin(cur.notBefore) > hhmmToMin(floor) ? cur.notBefore : floor };
    }
  }
  const input = {
    ...st.input,
    availability: { ...(st.input.availability || {}), [day.id]: av },
    existing: (L.games || []).map(g =>
      g.day === day.id && st.frozen.has(g.key) ? { ...g, locked: true } : g)
  };

  const { games } = generateSeason(input, {
    phases: ['pack'], onlyDays: [day.id], restarts: LIVE_RESTARTS, dayBudgetMs: LIVE_BUDGET_MS
  });

  const cur = new Map(st.dayGames.map(g => [g.key, g]));
  const newPlace = new Map();
  const moves = [];
  for (const ng of games) {
    if (ng.day !== day.id) continue;
    const g = cur.get(ng.key);
    if (!g) continue;
    if (!ng.slot || !ng.net) { if (g.slot) return null; continue; }   // משחק שנשמט — לא מציעים
    newPlace.set(ng.key, { slot: ng.slot, net: ng.net });
    if (ng.slot !== g.slot || ng.net !== g.net)
      moves.push({ id: g.id, key: g.key, slot: ng.slot, net: ng.net, from: { slot: g.slot, net: g.net } });
  }
  if (!moves.length) return null;
  // חגורה ושלייקס: הנעילה והחלון הם קלט למתזמן, וכאן בודקים את **הפלט**.
  for (const m of moves) if (st.frozen.has(m.key) || m.slot <= nowSlot) return null;

  const cost = dayCost(newPlace, st.ctx);
  if (cost.hard > st.base.hard) return null;
  const pairSaved = Math.max(0, ...moves.map(m => (m.from.slot - m.slot) * day.slotMin));
  // שרשרת מוצעת **רק** אם היום באמת נגמר מוקדם יותר. אריזה מחדש מזיזה עשרות
  // משחקים ומשנה את השעה לכל הקבוצות; בלי סיום מוקדם זו טלטלה בתמורה לרווח
  // של זוג בודד — וזה כבר "סדר לי את היום מחדש" של §8.6, לא הצעה של §8.7.
  const endSaved = (st.base.lastSlot - cost.lastSlot) * day.slotMin;
  if (endSaved <= 0) return null;
  const one = moves[0];
  return liveSug(st, moves.length > 1 ? 'group'
                   : liveKindOf({ slot: one.from.slot, net: one.from.net }, one.slot, one.net),
                 moves, cost, pairSaved);
}

// חתימת המצב — כל שינוי בשיבוץ, בתוצאות או בסלוט הרץ מבטל את המטמון.
// בלי זה כל paint() (וכל הקלדה בעמוד) היה מריץ את הסריקה מחדש.
function liveSig(dayId) {
  const day = (L.meta.days || []).find(d => d.id === dayId);
  const gs = (L.games || []).filter(g => g.day === dayId)
    .map(g => `${g.key}:${g.slot}:${g.net}:${g.locked ? 1 : 0}:${g.result}`).join(',');
  return `${dayId}|${day ? liveSlotNow(day) : 0}|${gs}`;
}

function liveScan(dayId) {
  const sig = liveSig(dayId);
  if (liveCache && liveCache.sig === sig) return liveCache.list;
  const st = liveState(dayId);
  const list = st ? liveSingles(st) : [];
  // ההצעה הקבוצתית נשמרת מהחישוב הכבד האחרון ומצטרפת רק אם המצב לא זז מאז.
  // שרשרת שהתכווצה למהלך בודד שכבר ברשימה לא מוצגת פעמיים.
  const grp = liveGroupRes?.sig === sig ? liveGroupRes.sug : null;
  const same = (a, b) => a.moves.length === b.moves.length &&
    a.moves.every((m, i) => m.id === b.moves[i].id && m.slot === b.moves[i].slot && m.net === b.moves[i].net);
  if (grp && !list.some(s => same(s, grp))) list.push(grp);
  // מיון לפי הזמן שנחסך (§8.7); בתיקו — המהלך שמזיז פחות משחקים קודם.
  list.sort((a, b) => b.score - a.score || a.moves.length - b.moves.length);
  let top = list.slice(0, LIVE_TOP);
  // חישוב שהמנהלת ביקשה במפורש לא נחתך על ידי הקיצוץ
  if (grp && list.includes(grp) && !top.includes(grp)) top = [...top.slice(0, LIVE_TOP - 1), grp];
  liveCache = { sig, list: top };
  return top;
}

// היום שהכי הגיוני לעבוד עליו: זה שקורה היום, אחרת הקרוב שטרם עבר.
function liveDefaultDay(days) {
  const t = todayISO();
  return (days.find(d => d.date === t) || days.find(d => !d.date || d.date >= t) || days[days.length - 1])?.id || null;
}

const LIVE_KIND = { advance:'הקדמה', move:'הזזה', group:'הזזה קבוצתית' };

// ── הפאנל: הודעה אחת מרוכזת (§8.7), לא התראות שקופצות ──
function livePanel() {
  const days = regularDays().filter(d => (L.games || []).some(g => g.day === d.id && g.slot));
  if (!days.length) return '';
  if (!liveDay || !days.some(d => d.id === liveDay)) liveDay = liveDefaultDay(days);

  const on = liveOn();
  const sugs = on && !liveBusy ? liveScan(liveDay) : [];
  const summary = !on ? 'עדכון לוז חי · <span class="muted">כבוי</span>'
    : liveBusy ? 'עדכון לוז חי · <span class="muted">מחשב…</span>'
    : sugs.length ? `עדכון לוז חי · <b>${sugs.length}</b> ${sugs.length === 1 ? 'הזדמנות' : 'הזדמנויות'}`
                  : 'עדכון לוז חי · <span class="muted">אין מה להקדים</span>';

  const toggle = `<label class="toggle-switch" title="כבוי = הלוז יציב לגמרי, בלי הצעות">
      <input type="checkbox"${on ? ' checked' : ''} data-act="live.toggle"/>
      <span class="toggle-slider"></span>
      <span class="toggle-txt">חשב הזדמנויות להקדים</span>
    </label>`;

  let body;
  if (!on) {
    body = `<div class="pub-tools">${toggle}</div>
      <span class="sett-desc">כשהמתג דלוק, כל פעם שנרשמת תוצאה המערכת בודקת אילו משחקים
        אפשר להקדים לרשת שהתפנתה, ומציגה כאן רשימה מדורגת. <strong>שום דבר לא זז
        לבד</strong> — כל הזזה קורית רק בלחיצה שלך.</span>`;
  } else {
    const st = liveBusy ? null : liveState(liveDay);
    const day = days.find(d => d.id === liveDay);
    const picker = `<div class="day-picker">${days.map(d =>
      `<button class="filter-btn${d.id === liveDay ? ' on' : ''}" data-act="live.day"
        data-day="${escH(d.id)}">${escH(d.label)}</button>`).join('')}</div>`;

    const readout = st ? `<div class="pub-tools">
        <span class="q-chip">עכשיו <b class="num">${escH(liveNowLabel())}</b>
          ${st.nowSlot ? `· רץ <b class="num">${escH(slotTime(st.day, st.nowSlot))}</b>` : '· המחזור טרם התחיל'}</span>
        <span class="q-chip">היום נגמר ב-<b class="num">${escH(slotTime(st.day, st.base.lastSlot + 1))}</b></span>
        <span class="q-chip">${st.dayGames.length - st.frozen.size} משחקים עוד יכולים לזוז</span>
        <button class="cf-btn" data-act="live.refresh">↻ בדוק שוב</button>
        <button class="cf-btn" data-act="live.group">🔗 חפש הזזה קבוצתית</button>
        ${liveGroupRes?.sig === liveSig(liveDay) && !liveGroupRes.sug
          ? `<span class="muted">נבדקה אריזה מחדש של היום — אין שרשרת שמסיימת מוקדם יותר.</span>` : ''}
        ${DEV ? `<label class="toggle-txt">בדיקה — עכשיו:
          <input class="text-inp att-time" type="time" value="${escH(liveNowStr)}" data-act="live.now"/></label>` : ''}
      </div>` : `<div class="empty">אין לוז למחזור הזה.</div>`;

    const rows = !st ? '' : sugs.map((s, i) => {
      const m = s.moves[0];
      const g = findGame(m.id);
      const some = s.moves.slice(0, 2).map(x => TEAM_NAME(findGame(x.id)?.a)).join(' · ');
      const who = s.moves.length > 1
        ? `<b>${s.moves.length} משחקים</b> <span class="muted">${escH(some)}…</span>`
        : `${escH(TEAM_NAME(g.a))} <span class="muted">נגד</span> ${escH(TEAM_NAME(g.b))}`;
      const to = s.moves.length > 1
        ? `<span class="muted">אריזה מחדש · סיום ב-</span><b class="num">${escH(slotTime(st.day, s.endSlot + 1))}</b>`
        : `<b class="num">${escH(slotTime(st.day, m.slot))}</b>
           <span class="net-chip" style="background:${escH(NET_COLOR(m.net))};color:${onColor(NET_COLOR(m.net))}"
             >${escH(NET_NAME(m.net))}</span>
           <span class="muted">היה ${escH(slotTime(st.day, m.from.slot))} · ${escH(NET_NAME(m.from.net))}</span>`;
      const saved = [
        s.endSaved > 0 ? `<b>היום נגמר ${s.endSaved} דק׳ מוקדם</b>` : '',
        s.pairSaved > 0 ? `<span class="muted">${s.moves.length > 1 ? 'עד ' : ''}${s.pairSaved} דק׳ מוקדם לזוג</span>` : ''
      ].filter(Boolean).join('<br/>');
      return `<tr>
        <td><span class="gtag">${escH(LIVE_KIND[s.kind])}</span></td>
        <td class="att-name">${who}</td>
        <td>${to}</td>
        <td>${saved}</td>
        <td>${s.warns.length ? `<span class="pub-none">⚠ ${escH(s.warns.join(' · '))}</span>` : ''}</td>
        <td class="att-mark"><button class="filter-btn" data-act="live.apply" data-i="${i}"
          >${s.kind === 'group' ? `הזז את ה-${s.moves.length}` : s.kind === 'advance' ? 'הקדם' : 'הזז'}</button></td>
      </tr>`;
    }).join('');

    const table = !st ? '' : sugs.length ? `<div class="tscroll"><table class="stbl att-tbl">
        <thead><tr><th>סוג</th><th>מי</th><th>לאן</th><th>כמה נחסך</th><th>אזהרה</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${liveBusy ? 'מחשב…' : 'אין כרגע הזדמנות שחוסכת זמן ולא שוברת אף חוק.'}</div>`;

    body = `${picker}${readout}${table}
      <span class="sett-desc">הרשימה מדורגת לפי הזמן שנחסך. כל הצעה כבר נבדקה מול
        <strong>כל</strong> חוקי הלוז (${escH(day?.label || '')}) — מה ששובר אילוץ קשיח
        לא מופיע כאן בכלל, ומה שמפר כלל רך מופיע עם אזהרה. משחק שכבר התחיל, נגמר או
        נעול 📌 לא זז. משיכה של יותר מ-${LIVE_PULL_OK_MIN} דק׳ קדימה תבקש אישור נוסף.
        <strong>שום דבר לא קורה עד הלחיצה.</strong></span>`;
  }

  return `<details class="sett-section mpanel live-bar" id="sec-live"${openSections.has('live') ? ' open' : ''}>
    <summary class="sett-section-title">${summary}</summary>
    <div class="mpanel-body pub-bar-body">${body}</div>
  </details>`;
}

// ============================================================================
// חיווט
// ============================================================================

// ES modules לא דולפים ל-window, ולכן onclick="fn()" בתוך HTML לא היה מוצא
// כלום. app.js פותר את זה עם Object.assign(window, {...}) של 40 שמות; כאן
// במקום זה האצלה אחת ברמת המסמך + data-act. אין גלובלים, והמאזינים שורדים
// כל re-render — מה שיהיה קריטי בלוח הגרירה בשלב 5.
const ACT = {
  // ── קבוצות ──
  'team.add': el => { (L.roster[el.dataset.cat] ||= []).push(newTeam(el.dataset.cat)); },
  'team.del': el => {
    const f = findTeam(el.dataset.id); if (!f) return false;
    if (!confirm(`למחוק את "${f.team.name || f.team.id}"?`)) return false;
    L.roster[f.cat] = L.roster[f.cat].filter(t => t.id !== f.team.id);
  },
  // משבצת שחקנית. הערך שנשמר הוא **מזהה** (§5.4) ולא שם — resolveSlot מכריע
  // אם השם שהוקלד הוא שחקנית קיימת (שיוך, וכך שתי הקבוצות חולקות אותה), תיקון
  // שם של מי שכבר בסלוט, או שחקנית חדשה. השם המאוחד (החלטה 8) נגזר מהמרשם;
  // זוג/שלישייה נגזר ממספר הסלוטים המלאים ולא נשמר.
  'team.player': el => {
    const f = findTeam(el.dataset.id); if (!f) return false;
    const slots = teamSlots(f.team);
    const slot  = +el.dataset.slot;
    slots[slot] = resolveSlot(el.value.trim().replace(/\s+/g, ' '), slots[slot], f.cat, f.team.id);
    f.team.players = slots;
    syncTeamNames(L);
    syncRosterInputs();
  },

  // ── כללי ──
  'meta.name':    el => { L.meta.name = el.value.trim(); },
  'meta.logoUrl': el => { L.meta.logoUrl = el.value.trim(); },
  'meta.font':    el => { L.meta.font = el.value; },

  // הצבע הוא היוצא מן הכלל היחיד לכלל ה-onchange: הוא נשמר תוך כדי גרירה
  // בלוח. לכן הוא לא מפעיל paint() — re-render באמצע גרירה סוגר את הלוח.
  'meta.color': el => {
    L.meta[el.dataset.key] = el.value;
    const hex = document.getElementById('ct-' + el.dataset.key);
    if (hex) hex.value = el.value;
    applyTheme(L.meta.primaryColor, L.meta.secondaryColor, { hasLogo: !!L.meta.logoUrl });
    return false;
  },
  'meta.colorHex': el => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(el.value)) { el.value = L.meta[el.dataset.key]; return false; }
    L.meta[el.dataset.key] = el.value;
  },

  // ── ספונסרים ──
  'sponsor.add': () => { (L.meta.sponsorLogos ||= []).push({ url:'', alt:'' }); },
  'sponsor.del': el => { L.meta.sponsorLogos.splice(+el.dataset.i, 1); },
  'sponsor.url': el => { L.meta.sponsorLogos[+el.dataset.i].url = el.value.trim(); },
  'sponsor.alt': el => { L.meta.sponsorLogos[+el.dataset.i].alt = el.value.trim(); },

  // ── ליגות ופורמטים ──
  'cat.name': el => { const c = L.categories.find(x => x.id === el.dataset.cat); if (c) c.name = el.value.trim(); },
  'cat.rr':   el => { const c = L.categories.find(x => x.id === el.dataset.cat); if (c) c.rr = +el.value; },
  'fmt.sets': el => {
    const f = L.formats[el.dataset.cat][el.dataset.stage];
    f.sets = +el.value;
    if (f.sets === 3) f.third ??= 15; else delete f.third;
  },
  'fmt.to':    el => { L.formats[el.dataset.cat][el.dataset.stage].to    = +el.value || null; },
  'fmt.third': el => { L.formats[el.dataset.cat][el.dataset.stage].third = +el.value || null; },
  // שדה ריק = ללא תקרה, ולא אפס. null הוא ערך אמיתי במודל (החלטה 18).
  'fmt.cap':   el => { L.formats[el.dataset.cat][el.dataset.stage].cap = el.value === '' ? null : +el.value; },

  // ── רשתות ──
  'net.name': el => { L.meta.nets[+el.dataset.i].name = el.value.trim(); },
  'net.color': el => {
    L.meta.nets[+el.dataset.i].color = el.value;
    const hex = document.getElementById('ct-net' + el.dataset.i);
    if (hex) hex.value = el.value;
    return false;
  },
  'net.colorHex': el => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(el.value)) { el.value = L.meta.nets[+el.dataset.i].color; return false; }
    L.meta.nets[+el.dataset.i].color = el.value;
  },

  // ── ימים ──
  'day.label':     el => { L.meta.days[+el.dataset.i].label = el.value.trim(); },
  'day.date':      el => { L.meta.days[+el.dataset.i].date = el.value || null; },
  'day.startTime': el => { L.meta.days[+el.dataset.i].startTime = el.value || '17:00'; },
  'day.beach':     el => { L.meta.days[+el.dataset.i].beach = el.value.trim(); },
  'day.slotMin':   el => { L.meta.days[+el.dataset.i].slotMin = Math.max(5, +el.value || 20); },
  'day.slots':     el => { L.meta.days[+el.dataset.i].slots   = Math.max(1, +el.value || 16); },
  'day.published': el => { L.meta.days[+el.dataset.i].published = el.checked; },
  'day.net': el => {
    const d = L.meta.days[+el.dataset.i], id = +el.dataset.net;
    d.netIds = el.checked ? [...new Set([...d.netIds, id])].sort((a, b) => a - b)
                          : d.netIds.filter(x => x !== id);
  },

  // ── המתזמן (שלב 3) ──
  // כל שלב בנפרד לפי §6.1. הרצה חוזרת שומרת תוצאות ונעילות לפי מזהה המשחק
  // הלוגי (ליגה|א|ב|סיבוב), אבל אם הרוסטר השתנה המזהה משתנה איתו — ולכן
  // אזהרה מפורשת כשיש תוצאות על השולחן.
  'sched.all':  () => { if (confirmRegen()) runScheduler(['rr', 'days', 'pack']); return false; },
  'sched.rr':   () => { if (confirmRegen()) runScheduler(['rr']); return false; },
  // ב׳ ו-ג׳ לא מגרילים RR מחדש — הם עובדים על המשחקים ששמורים במסמך, ולכן
  // תוצאות ונעילות לא בסכנה ואין מה לאשר.
  'sched.days': () => { runScheduler(['days']); return false; },
  'sched.pack': () => { runScheduler(['pack']); return false; },
  'sched.day':  el => { schedDay = el.dataset.day; },
  'sched.clear': () => {
    if (!confirm('למחוק את כל הלוז? התוצאות שהוזנו יימחקו איתו.')) return false;
    L.games = []; schedLast = null;
  },

  // בדיקה בלבד (?dev=1). §15.4 — רשימת הקבוצות האמיתית מתפרסמת אחרי 12.8.
  'sched.seed': () => {
    if (!DEV) return false;
    if (!confirm('למלא רוסטר בדיקה של 15·15·6 קבוצות? הרוסטר הקיים יימחק.')) return false;
    seedTestRoster();
  },

  // ── דירוג + הזנת תוצאות (שלב 4) ──
  // שינוי שפה — תצוגה בלבד, ולכן NO_SAVE ורמה 0 (ראו הרשימות למטה).
  'lang.set':        el => { setLang(el.dataset.lang); },

  'stand.cat':       el => { standCat = el.dataset.cat; standTeam = null; },
  'stand.team':      el => { standTeam = standTeam === el.dataset.id ? null : el.dataset.id; },

  // ניקוד: שומר sa/sb; שני ערכים תקינים → ok, אחרת חוזר ל-pending.
  'res.score': el => {
    const g = findGame(el.dataset.id); if (!g) return false;
    const wasOk = g.result === 'ok';
    const v = el.value === '' ? null : Math.max(0, Math.floor(+el.value) || 0);
    g[el.dataset.side] = v;
    g.sets = [];
    const fmt = L.formats[g.cat]?.regular || F_SET18;
    const complete = g.sa != null && g.sb != null;
    if (complete && validSet(Math.max(g.sa, g.sb), Math.min(g.sa, g.sb), fmt.to, fmt.cap))
      g.result = 'ok';
    else if (g.result === 'ok')
      g.result = 'pending';
    // רינדור מחדש רק כשהמשחק *שלם* (שני ציונים) או היה תקין — כך הטבלה זזה בלייב
    // ברגע שיש תוצאה, אבל מילוי התיבה הראשונה (השנייה ריקה) לא בונה מחדש את ה-DOM
    // תחת האצבע, ואפשר לעבור לתיבה השנייה בלי לאבד את מה שמקלידים (מלכודת 3).
    if (!complete && !wasOk) return false;
  },
  'res.tech': el => {
    const g = findGame(el.dataset.id); if (!g) return false;
    setTech(g, el.dataset.side);
  },
  // היעדרות ליום שלם (מאסטר, §10.3): attendance=noshow + הפסד טכני 18:10 לכל
  // משחקי הקבוצה באותו יום. זה מה שמפריד "היעדרות" מ"טכני" בטבלה.
  'res.noshowDay': el => {
    const team = el.dataset.team, day = el.dataset.day;
    const t = findTeam(team);
    if (!confirm(`לסמן היעדרות של "${t?.team.name || team}" ל${dayLabel(day)}? כל משחקיה באותו יום יירשמו כהפסד טכני 18:10.`)) return false;
    (L.attendance[day] ||= {})[team] = 'noshow';
    for (const g of (L.games || [])) {
      if (g.day !== day) continue;
      if (g.a === team) setTech(g, 'a');
      else if (g.b === team) setTech(g, 'b');
    }
  },

  // ── הרשאות (§7.1) ──
  // כפתור אחד לשלושה מצבים: אין סיסמה → ישר למקטע "גישה"; מחוברת → יציאה;
  // אחרת → דיאלוג הכניסה.
  'auth.click': () => {
    if (!secured()) { page = 'settings'; openSections.add('access'); paint(); return false; }
    if (realRole()) {
      if (!confirm(t('auth.exitQ'))) return false;
      role = 0; previewPublic = false; storeRole(); paint();
      return false;
    }
    openLogin();
    return false;
  },
  'auth.submit': () => { tryLogin(); return false; },
  'auth.close':  () => { closeLogin(); return false; },

  // ── פרסום (§8.5) ──
  'pub.toggle': el => {
    const d = (L.meta.days || []).find(x => x.id === el.dataset.day);
    if (!d) return false;
    d.published = !d.published;
  },
  'pub.preview': () => { previewPublic = true; page = 'schedule'; paint(); return false; },
  'pub.exit':    () => { previewPublic = false; paint(); return false; },
  'pub.day':     el => { pubDay = el.dataset.day; },
  'pub.clearSearch': () => { setQuery(''); },

  // ── נוכחות וזמינות (§8.4) ──
  'att.day':   el => { attDay = el.dataset.day; },
  'av.before': el => setAvail(el, 'notBefore', el.value || null),
  'av.after':  el => setAvail(el, 'notAfter',  el.value || null),
  'av.note':   el => setAvail(el, 'note', el.value.trim() || null),
  // "הגיעה" הוא גם הביטול של "נעדרה": אם כבר נרשמו הפסדים טכניים בגללה,
  // מציעים לנקות אותם — אחרת סימון בטעות היה נשאר בטבלה לנצח.
  'att.ok': el => {
    const { team, day } = el.dataset;
    const was = L.attendance?.[day]?.[team];
    (L.attendance[day] ||= {})[team] = 'ok';
    if (was === 'noshow') {
      const techs = (L.games || []).filter(g => g.day === day &&
        ((g.a === team && g.result === 'tech_a') || (g.b === team && g.result === 'tech_b')));
      if (techs.length && confirm(`לבטל גם את ${techs.length} ההפסדים הטכניים שנרשמו לה ב${dayLabel(day)}?`))
        for (const g of techs) setTech(g, 'clear');
    }
  },

  // ── דחיסת לוז חיה (§8.7) — מאסטר בלבד דרך ברירת המחדל של ACT_LEVEL ──
  'live.toggle':  el => { L.meta.liveReschedule = el.checked; liveCache = null; liveGroupRes = null; },
  'live.day':     el => { liveDay = el.dataset.day; liveCache = null; },
  'live.refresh': () => { liveCache = null; liveGroupRes = null; },
  'live.now':     el => { liveNowStr = el.value || ''; liveCache = null; liveGroupRes = null; },

  // האריזה הקבוצתית היא החישוב הכבד (~שנייה), ולכן אותה תבנית של runScheduler:
  // לצייר "מחשב…" קודם, ורק אז לחשב. היא לא משנה כלום — רק מייצרת הצעה.
  'live.group': () => {
    if (liveBusy) return false;
    liveBusy = true; paint();
    setTimeout(() => {
      const sig = liveSig(liveDay);
      try {
        const st = liveState(liveDay);
        liveGroupRes = { sig, sug: st ? liveGroup(st) : null };
      } catch (e) {
        console.error('Live group scan failed', e);
        liveGroupRes = { sig, sug: null };
      }
      liveCache = null; liveBusy = false; paint();
    }, 30);
    return false;
  },

  // הביצוע. עד כאן שום דבר לא זז (§8.7 — עקרון-על): רק כאן, ורק אחרי אימות
  // שהמצב לא השתנה מאז שההצעה חושבה, ואישור נוסף אם יש אזהרה.
  'live.apply': el => {
    const sugs = liveScan(liveDay);
    const s = sugs[+el.dataset.i];
    if (!s) return false;
    const taken = new Set();
    const moving = new Set(s.moves.map(m => m.id));
    for (const g of (L.games || []))
      if (g.day === liveDay && g.slot && g.net && !moving.has(g.id)) taken.add(g.slot + '|' + g.net);
    for (const m of s.moves)
      if (taken.has(m.slot + '|' + m.net) || !findGame(m.id)) {
        alert('הלוז השתנה מאז החישוב. לחצי "בדוק שוב".');
        liveCache = null; liveGroupRes = null;
        paint();       // רשימה מעודכנת, בלי לכתוב את המסמך
        return false;
      }
    if (s.warns.length && !confirm(`⚠ ${s.warns.join('\n⚠ ')}\n\nלבצע בכל זאת?`)) return false;
    for (const m of s.moves) { const g = findGame(m.id); g.slot = m.slot; g.net = m.net; }
    liveCache = null; liveGroupRes = null;
  },

  // ── טלפונים — דוק פרטי נפרד, ולכן שמירה משלו ולא queueSave (§5.4) ──
  'team.phone': el => {
    setPhone(el.dataset.pid, el.value.trim())
      .catch(e => { console.error('Phone save failed', e); alert('הטלפון לא נשמר: ' + e.message); });
    return false;
  },

  // ── סיסמאות ──
  'pw.admin':   el => hashPassword('adminPasswordHash', el),
  'pw.manager': el => hashPassword('managerPasswordHash', el),

  // ── בדיקת סנכרון (dev) ──
  'dev.name': el => { L.meta.name = el.value.trim(); }
};

// פעולות לוח הגרירה (שלב 5). כולן בקידומת board.* וכל אחת עושה queueSave/paint
// בעצמה, ולכן handle() לא שומר/מרנדר אותן אוטומטית (ראו התנאי ב-handle).
Object.assign(ACT, Board.ACT);

// בקשת זמינות אחת (§8.4). רשומה שכל שדותיה התרוקנו נמחקת ולא נשארת כאובייקט
// ריק — המתזמן קורא את availability כמפה של אילוצים, ורשומה ריקה היא רעש.
function setAvail(el, key, v) {
  const { day, team } = el.dataset;
  const d = (L.availability[day] ||= {});
  const e = (d[team] ||= { notBefore: null, notAfter: null, note: null });
  e[key] = v;
  if (!e.notBefore && !e.notAfter && !e.note) delete d[team];
  if (!Object.keys(d).length) delete L.availability[day];
}

function confirmRegen() {
  const scored = (L.games || []).filter(g => g.result && g.result !== 'pending').length;
  if (!scored) return true;
  return confirm(`יש ${scored} משחקים עם תוצאה. הרצה מחדש שומרת תוצאה לכל משחק ` +
    `שנשאר אותו מפגש, אבל אם שינית את הרוסטר — תוצאות עלולות להימחק. להמשיך?`);
}

// רוסטר בדיקה. שמות אמיתיים באורך אמיתי, כדי שהגריד ייבדק בתנאים אמיתיים
// ולא מול "קבוצה 1". ?dev=1 בלבד, ורק מול futilina-test.
//
// שם מלא (פרטי + משפחה) ולא שם פרטי בלבד: המרשם מזהה שחקנית לפי שם, ושמות
// פרטיים חוזרים על עצמם. שחקניות השאו נלקחות **מתוך** ליגה א׳ ו-ב׳ (§5.4:
// שחקנית היא תמיד שאו + ליגה אחת), כדי שהמקרה המשותף ייבדק בפועל.
function seedTestRoster() {
  const first = ['רוני','טל','נועה','שירה','ליהי','עדי','מאיה','יערה','הילה','דנה',
                 'אור','ניצן','שקד','רותם','אביגיל','יובל','גאיה','תמר','אלה','נטע'];
  const last  = ['כהן','לוי','מזרחי','פרץ','ביטון','אדרי','שפירא','גולן'];
  const reg = {};
  let n = 0;
  const addPlayer = () => {
    const id = 'p' + String(++n).padStart(3, '0');
    reg[id] = { name: `${first[(n - 1) % first.length]} ${last[Math.floor((n - 1) / first.length) % last.length]}` };
    return id;
  };
  const mkTeam = (cat, i, pids) => ({
    id: `${CAT_PREFIX[cat]}t${String(i + 1).padStart(2, '0')}`,
    players: pids, name: pids.map(p => reg[p].name).join(' · '),
    active: true, withdrewAfterDay: null
  });
  // כל קבוצה שלישית = שלישייה, השאר זוגות
  const build = (cat, count) => Array.from({ length: count }, (_, i) =>
    mkTeam(cat, i, Array.from({ length: i % 3 === 0 ? 3 : 2 }, addPlayer)));

  const liga1 = build('liga1', 15);
  const liga2 = build('liga2', 15);
  const show  = Array.from({ length: 6 }, (_, i) =>
    mkTeam('show', i, [liga1[i * 2].players[0], liga2[i * 2 + 1].players[0]]));

  L.players = reg;
  L.roster  = { show, liga1, liga2 };
  L.games = []; schedLast = null;
}

// אסינכרוני, ולכן שומר בעצמו במקום להסתמך על המחזור של handle()
async function hashPassword(field, el) {
  const raw = el.value;
  el.value = '';
  L.meta[field] = raw ? await sha256(raw) : '';
  queueSave();
  paint();
  return false;
}

// שדה שרק משקף את עצמו לא מצדיק בנייה מחדש של העמוד. זה לא אופטימיזציה:
// paint() מחליף innerHTML, וכל שדה שעדיין לא נשמר מתנתק מה-DOM באמצע. מי
// שערכה שלוש שורות ברוסטר ברצף איבדה את שתי האחרונות. רק פעולה שמשנה משהו
// *מחוץ* לשדה עצמו — הוספה, מחיקה, מתג, או מדד מחושב — מפעילה רינדור.
const NO_REPAINT = new Set([
  'team.player', 'cat.name',
  'fmt.to', 'fmt.third', 'fmt.cap',
  'day.label', 'day.beach',
  'sponsor.url', 'sponsor.alt',
  'av.note'
]);

// פעולות שמשנות רק מה שמוצג ולא את המודל. בלי זה כל לחיצה על טאב של יום
// בעמוד המתזמן הייתה כותבת את המסמך כולו ל-Firestore — 240 משחקים על שינוי
// שקיים רק בדפדפן.
const NO_SAVE = new Set(['lang.set', 'sched.day', 'stand.cat', 'stand.team',
  'auth.click', 'auth.submit', 'auth.close',
  'pub.preview', 'pub.exit', 'pub.day', 'pub.clearSearch', 'att.day',
  // §8.7 — בחירת יום, רענון, שעת-בדיקה וחישוב ההצעה הקבוצתית אינם משנים
  // את המודל: הם רק מחשבים ומציגים. רק live.toggle ו-live.apply כותבים.
  'live.day', 'live.refresh', 'live.now', 'live.group',
  'team.phone']);   // הטלפון נכתב לדוק אחר לגמרי

// ── אכיפת ההרשאות (§7.1) ──
// ההאצלה היא ברמת המסמך, ולכן הסתרת כפתור אינה הגנה: אפשר לזייף לחיצה
// מהקונסולה. הגבול נאכף כאן, בשער היחיד שכל הפעולות עוברות בו.
// **ברירת המחדל היא מאסטר** — פעולה חדשה שנוסיף בעתיד ותישכח מהרשימות
// תיחסם, ולא תיפתח בשקט לציבור.
const ACT_LEVEL = {};
for (const a of ['lang.set', 'stand.cat', 'stand.team',
                 'auth.click', 'auth.submit', 'auth.close',
                 'pub.day', 'pub.clearSearch', 'pub.exit']) ACT_LEVEL[a] = 0;
for (const a of ['res.score', 'res.tech']) ACT_LEVEL[a] = 1;   // אדמין = הזנת תוצאות בלבד

function handle(e, kinds) {
  const el = e.target.closest('[data-act]');
  if (!el || !kinds.test(el.tagName)) return;
  const act = el.dataset.act;
  const fn = ACT[act];
  if (!fn) return;
  if (R() < (ACT_LEVEL[act] ?? 2)) return;
  const skip = fn(el, e) === false || NO_REPAINT.has(act);
  // פעולות board.* מנהלות שמירה ורינדור בעצמן (מטפל הלוח קורא ל-queueSave/paint
  // רק כשבאמת חל שינוי) — כדי שהחלפת תצוגה או בחירת יום לא יכתבו את המסמך כולו.
  if (!NO_SAVE.has(act) && !act.startsWith('board.')) queueSave();
  if (!skip) paintKeepScroll();   // שומר מיקום גלילה — הדף לא קופץ למעלה בכל פעולה
}

document.addEventListener('click',  e => {
  const tab = e.target.closest('[data-page]');
  if (tab) {
    const p = PAGES.find(x => x.id === tab.dataset.page);
    if (!p || !pageOk(p)) return;   // אותו שער בדיוק כמו בניווט — גם מול לחיצה מזויפת
    page = p.id; paint(); return;
  }
  // TR — שורת קבוצה בטבלת הדירוג לחיצה (§7.2: מציגה את משחקי הקבוצה)
  handle(e, /^(BUTTON|A|TR)$/);
});
document.addEventListener('change', e => handle(e, /^(INPUT|SELECT|TEXTAREA)$/));
// type=color בלבד — כל שאר השדות נשמרים ב-blur (מלכודת 3).
// היוצא השני: חיפוש הלוז הציבורי, שמסנן חי ולכן חייב oninput — ובגלל זה
// הוא גם לא עובר דרך handle() (בלי שמירה ובלי רינדור, רק classList).
document.addEventListener('input',  e => {
  if (e.target.type === 'color') { handle(e, /^INPUT$/); return; }
  if (e.target.id === 'pub-search') { setQuery(e.target.value); pubFilter(); }
});

// שער ההרשאות של מסך הפיינל פור (§7.1). league-ko.js אינו שלי בשלב הזה,
// והוא מאזין ברמת המסמך ב-bubble; מאזין ב-capture רץ לפניו ועוצר את
// האירוע. הזנת תוצאות = אדמין; בחירת סלוט (3.9.2) והחלפה (3.9.3) = מאסטר;
// מעבר לשונית/ליגה = כולן. אחרי חסימת change מרעננים, כדי שהערך שהוקלד
// בשדה לא יישאר על המסך בלי שנשמר.
const KO_LEVEL = { 'ko.tab': 0, 'ko.cat': 0, 'ko.score': 1, 'ko.cross': 1 };
function koGate(e) {
  const el = e.target.closest('[data-ko]');
  if (!el) return;
  if (R() >= (KO_LEVEL[el.dataset.ko] ?? 2)) return;
  e.stopPropagation();
  e.preventDefault();
  if (e.type === 'change') paint();
}
document.addEventListener('click',  koGate, true);
document.addEventListener('change', koGate, true);
// זכירת המקטעים הפתוחים באקורדיון ההגדרות
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.tagName !== 'DETAILS' || !d.id.startsWith('sec-')) return;
  const id = d.id.slice(4);
  d.open ? openSections.add(id) : openSections.delete(id);
}, true);

// חיבור לוח הגרירה (שלב 5): מזריק את המצב החי ואת הכלים ש-league.js מחזיק
// ושהמודול לא יכול לייבא (getL/queueSave/paint/שמות/הזנת תוצאה). את המתזמן
// ו-escH/onColor הלוח מייבא ישירות — הם טהורים.
Board.init({
  getL: () => L,
  queueSave, repaint: paint,
  schedInput, regularDays,
  findTeam, findGame,
  teamName: TEAM_NAME, netName: NET_NAME, netColor: NET_COLOR, catName: CAT_NAME,
  slotTime, dayEndTime,
  renderGameEntry,
  leagueId: LEAGUE_ID, isDev: DEV
});

(async function start() {
  // מסך הטעינה ורוד (החלטה 14). לפני שהמסמך נטען אין עדיין meta.loadingColor,
  // ולכן הצבע הראשוני מגיע מקבוע המותג; ברגע שהמסמך זמין הוא גובר.
  const load = document.getElementById('view-loading');
  load.style.background = BRAND_PINK;
  load.style.color = onColor(BRAND_PINK);

  let outcome;
  try {
    outcome = await loadLeague();
  } catch (e) {
    console.error('League load failed', e);
    load.classList.add('h');
    document.getElementById('view-error').classList.remove('h');
    document.getElementById('error-detail').textContent = e.message;
    return;
  }

  if (outcome === 'missing') {
    load.classList.add('h');
    const v = document.getElementById('view-missing');
    v.classList.remove('h');
    v.querySelector('#missing-id').textContent = LEAGUE_ID;
    v.querySelector('#missing-link').href = `?l=${encodeURIComponent(LEAGUE_ID)}&init=1`;
    return;
  }

  load.classList.add('h');
  document.getElementById('view-app').classList.remove('h');
  restoreRole();   // §7.1 — כניסה שנעשתה בלשונית הזאת שורדת רענון
  document.documentElement.lang = getLang();   // ‎dir‎ נשאר rtl — ראו league-i18n.js
  paint();
  setSync('ok');
  // ‎?m=1‎ הוא **קישור הכניסה**, ולכן הוא פותח את הדיאלוג מיד. ביטול משאיר
  // את הכפתור ברצועה, כך שאין צורך לטעון מחדש כדי לנסות שוב.
  if (MGR && secured() && !realRole()) openLogin();
})();
