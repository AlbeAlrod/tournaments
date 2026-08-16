// ============================================================================
// league.js — ליגת קיץ פוצ׳ילינה 2026
//
// שלב 1 מתוך §14 במפרט: מודל הנתונים + סנכרון חי.
// אין כאן עדיין מתזמן, לוח גרירה, טבלת דירוג או הרשאות — אלה שלבים 3–7.
//
// המסמך היחיד: tournaments/{LEAGUE_ID}. ראו §5.1 במפרט.
// ============================================================================

import {
  db, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  escH, sha256, applyTheme, onColor, focusSnapshot, focusRestore
} from './common.js?v=2';

// המתזמן — שלב 3. מודול טהור: הוא לא מכיר את L, את ה-DOM או את Firestore,
// והוא מקבל תמונת מצב ומחזיר משחקים ודוח. ראו league-sched.js.
import {
  generateSeason, buildDayContext, dayCost, dayLength, slotLabel
} from './league-sched.js?v=6';

// לוח הגרירה — שלב 5. מודול תצוגה+שליטה שמקבל את המצב החי דרך Board.init().
// אין לו window.* globals; פעולותיו בקידומת board.* ומוזרקות ל-ACT (ראו start()).
import Board from './league-board.js?v=8';
import KO from './league-ko.js?v=1';

// ============ זהות הליגה ============
// ⚠️ המזהה הזה מופיע בכתובת הציבורית שכל 72 השחקניות מקבלות. הוא לא זמני.
// הפרמטר הוא ?l= ולא ?t= — ?t= שייך לאפליקציית הטורנירים, וערבוב בין השניים
// היה שולח מישהי לעמוד הלא נכון. ?l=futilina-test מאפשר לבדוק בלי לגעת בדוק
// האמיתי (מלכודת 6: בדיקות באפליקציה החיה כותבות ל-Firestore האמיתי).
const params    = new URLSearchParams(location.search);
const LEAGUE_ID = params.get('l') || 'futilina-2026';
const DEV       = params.get('dev') === '1';
const INIT      = params.get('init') === '1';   // יצירת דוק חדש — ראו loadLeague()

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

      showPastDays: true,
      tieBreak: ['pts','diff','h2h'],   // 3.10 — נעול, לא ניתן לשינוי

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
// בנפרד. `name` נגזר מהשמות המלאים ומוצג כיחידה אחת (החלטה 8 נשמרת בתצוגה);
// `players` נשמר כדי שאפשר יהיה לערוך כל שם בנפרד. `size` נגזר, לא נשמר.
function newTeam(catId) {
  return {
    id: nextTeamId(catId),
    players: ['', '', ''],   // עד 3 (2.1); מספר המלאים קובע זוג/שלישייה
    name: '',                // = players.filter(Boolean).join(' ')
    // active/withdrewAfterDay נשארים במודל לטובת 6.1 בשלב 4 (הזנת תוצאות),
    // בלי פקד ברוסטר: פרישה נדירה, ומטופלת במחיקה או בסימון "טכני" למשחק (§10.3).
    active: true,
    withdrewAfterDay: null
  };
}

// עד 3 שמות. תומך גם בקבוצות ישנות שנשמרו עם name בלבד (לפני השינוי).
// זוג/שלישייה נגזר ממספר השמות המלאים ולא נשמר בנפרד.
function teamPlayers(t) {
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
  if (tx) tx.textContent = detail || ({ ok:'מסונכרן', wait:'שומר…', err:'שגיאת סנכרון' }[state] || '');
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
  return {
    meta:         { ...d.meta, ...(data.meta || {}) },
    categories:   data.categories?.length ? mergeCats(data.categories) : d.categories,
    formats:      { ...d.formats, ...(data.formats || {}) },
    roster:       { ...d.roster,  ...(data.roster  || {}) },
    availability: data.availability || {},
    attendance:   data.attendance   || {},
    games:        data.games        || [],
    blocks:       data.blocks       || [],
    ko:           { ...d.ko, ...(data.ko || {}) },
    crossover:    data.crossover    || []
  };
}

function payload() {
  return {
    meta: L.meta, categories: L.categories, formats: L.formats,
    roster: L.roster, availability: L.availability, attendance: L.attendance,
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
// תצוגה — שלד בלבד. העמודים האמיתיים נבנים בשלבים 4–7.
// ============================================================================

let page = 'teams';

const PAGES = [
  { id:'standings', label:'דירוג',            stage:4 },
  // "הקבוצה שלי" בוטל (§7.2). כל מה שנשאר ממנו: שדה החיפוש בלוז זוכר את
  // עצמו ב-localStorage. אין עמוד, אין כרטיס "המשחק הבא", אין נעיצה.
  { id:'schedule',  label:'לוז',              stage:5 },
  { id:'ko',        label:'פיינל פור והצלבה', stage:7 },
  { id:'teams',     label:'קבוצות',           stage:null },
  { id:'sched',     label:'מתזמן',            stage:null },
  { id:'settings',  label:'הגדרות',           stage:null },
  { id:'status',    label:'מצב המערכת',       stage:null }
];

// מקטעי ההגדרות הפתוחים. בלי זה כל הקלדה סוגרת את כל האקורדיון,
// כי paint() בונה מחדש את כל ה-innerHTML.
const openSections = new Set(['general']);

function paint() {
  const f = focusSnapshot();

  applyTheme(L.meta.primaryColor, L.meta.secondaryColor, {
    hasLogo: !!L.meta.logoUrl
  });
  applyFont(L.meta.font);
  applyLogo(L.meta.logoUrl);

  document.getElementById('header-name').textContent = L.meta.name || 'ליגה';
  document.title = L.meta.name || 'ליגה';

  document.getElementById('main-nav').innerHTML = PAGES.map(p =>
    `<button class="tab${p.id === page ? ' on' : ''}" data-page="${p.id}">${escH(p.label)}</button>`
  ).join('');

  const target = PAGES.find(p => p.id === page);
  document.getElementById('page-body').innerHTML =
      page === 'teams'     ? renderTeams()
    : page === 'sched'     ? renderSched()
    : page === 'settings'  ? renderSettings()
    : page === 'status'    ? renderStatus()
    : page === 'standings' ? renderStandings()
    : page === 'schedule'  ? Board.render()
    : page === 'ko'        ? KO.render()
    : renderPlaceholder(target);

  renderSponsorBar();
  focusRestore(f);
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

function renderPlaceholder(p) {
  return `<div class="sett-section empty">
    <h3>${escH(p.label)}</h3>
    <p>העמוד הזה ייבנה בשלב ${p.stage} מתוך §14 במפרט.</p>
  </div>`;
}

// ============================================================================
// עמוד קבוצות — §14 שלב 2
// ============================================================================

function renderTeams() {
  // שלושה שדות שם במקום בורר גודל (החלטת המשתמשת 24.7): 2 מלאים = זוג,
  // 3 = שלישייה. אין כפתור פעילה/פרשה (פרישה נדירה — מחיקה או "טכני" פר משחק,
  // §10.3), ואין קוד מזהה גלוי (פנימי — המנהלת לא צריכה אותו).
  const cards = L.categories.map(c => {
    const list = L.roster[c.id] || [];
    const PH = ['שחקנית ראשונה', 'שחקנית שנייה', 'שחקנית שלישית (רשות)'];
    const rows = list.map((t, i) => {
      const p = teamPlayers(t);
      const fields = [0, 1, 2].map(s => `
        <input class="text-inp team-player-inp" value="${escH(p[s])}" placeholder="${PH[s]}"
               data-act="team.player" data-id="${escH(t.id)}" data-slot="${s}"/>`).join('');
      return `
      <div class="team-row">
        <span class="team-num">${i + 1}</span>
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
  <div class="info-box">
    רשימת הקבוצות הרשמית מתפרסמת אחרי <strong>12.8.2026</strong> (נספח ב׳ לתקנון).
    עד אז אפשר להזין ידנית. לפי 2.11.2 מותר להחליף או להוסיף שחקנית אחת עד
    <strong>27.8.2026</strong> — שינוי שם הקבוצה כאן מתעדכן אוטומטית בכל משחקיה,
    כי המשחקים מצביעים על המזהה ולא על השם.
  </div>
  ${cards}`;
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

  const intro = `
  <div class="info-box">
    <strong>שלב 3 — המתזמן.</strong> שלושת השלבים של §6.1 רצים בנפרד:
    <b>א׳</b> מחזורי RR בשיטת המעגל · <b>ב׳</b> חלוקה ל-${days.length} ימים שווים ·
    <b>ג׳</b> אריזה לגריד סלוט×רשת עם פאס תיקון. הקצב 4-3-4-3 של §6.1.ג.2
    <em>נגזר</em> מכלל אי־הרצף ולא מקודד: בליגה של N קבוצות שני סלוטים סמוכים
    יכולים להכיל יחד ⌊N/2⌋ משחקים לכל היותר, כי הם דורשים קבוצות שונות.
  </div>`;

  if (!anyTeams) return intro + `
    <div class="sett-section empty">
      <h3>אין עדיין קבוצות</h3>
      <p>המתזמן צריך לפחות שתי קבוצות פעילות בליגה אחת. רשימת הקבוצות
         מתפרסמת אחרי <strong>12.8.2026</strong> (§15.4); עד אז אפשר להזין אותן
         בעמוד <b>קבוצות</b>.</p>
      ${DEV ? `<div class="sett-add-row"><button class="add-cat-btn" data-act="sched.seed">
         מילוי רוסטר בדיקה (15 · 15 · 6)</button></div>` : ''}
    </div>`;

  // ── פקדים ──
  const busy = schedBusy ? ' disabled' : '';
  const controls = `
  <div class="sett-section">
    <div class="sett-section-title">הרצה</div>
    <div class="sched-actions">
      <button class="cf-btn" data-act="sched.all"${busy}>הכל — א׳ + ב׳ + ג׳</button>
      <button class="filter-btn" data-act="sched.rr"${busy}>א׳ · מחזורי RR</button>
      <button class="filter-btn" data-act="sched.days"${busy}${st.rr ? '' : ' disabled'}>ב׳ · חלוקה לימים</button>
      <button class="filter-btn" data-act="sched.pack"${busy}${st.days ? '' : ' disabled'}>ג׳ · אריזה + תיקון</button>
      <button class="team-del sched-clear" data-act="sched.clear"${busy}>מחיקת הלוז</button>
    </div>
    <div class="sched-state">
      ${chip('א׳ RR', st.rr, st.games ? `${st.games} משחקים` : '')}
      ${chip('ב׳ ימים', st.days, st.days ? `${days.length} מחזורים` : '')}
      ${chip('ג׳ גריד', st.pack, '')}
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
    <span class="sett-desc" style="margin-top:10px">כל קבוצה פוגשת כל קבוצה אחרת
      בליגה שלה (3.4). המשחקים האלה מתחלקים על פני הימים בשלב ב׳, כך שכל יום יוצא
      מאוזן — 3.6 מתיר 1–5 משחקים לקבוצה במחזור.</span>
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
    ${colorRow('loadingColor',   'צבע מסך טעינה', 'ורוד לפי החלטה 14.')}
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
    מערכה עד 21 בהפרש 2 בלי גג (החלטה 18). כל השאר: תקרה 25 לפי 3.5.
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
    <strong>נעול לפי 3.10 בתקנון — אינו ניתן לשינוי.</strong>
    <ol style="margin:8px 0 0;padding-inline-start:20px;line-height:1.9">
      <li>נקודות כלליות</li>
      <li>הפרש נקודות (3.10.1)</li>
      <li>שתי קבוצות — מפגש ישיר (3.10.2)</li>
      <li>שלוש ומעלה — מיני־ליגה בין הקשורות בלבד: נקודות ואז הפרש (3.10.3 והרחבתו)</li>
    </ol>
  </div>`;

  // ── 6. גישה ופעולות ──
  const access = `
    ${row('סיסמת אדמין', 'הזנת תוצאות וסימון טכני.',
      `<input class="text-inp" type="password" style="width:200px" placeholder="${m.adminPasswordHash ? '•••••• (מוגדרת)' : 'לא מוגדרת'}" data-act="pw.admin"/>`)}
    ${row('סיסמת מאסטר', 'גישה מלאה, כולל ימים מוסתרים ולוח הגרירה.',
      `<input class="text-inp" type="password" style="width:200px" placeholder="${m.managerPasswordHash ? '•••••• (מוגדרת)' : 'לא מוגדרת'}" data-act="pw.manager"/>`)}
    <div class="info-box" style="margin:12px 0 0">
      הסיסמאות נשמרות כ-SHA-256 בלבד. עם זאת — אין Firebase Auth, וההרשאות
      נאכפות בדפדפן. מי שיודעת את מזהה הליגה יכולה לקרוא את המסמך הגולמי כולל
      ה-hash. ראו <code>SECURITY.md</code>. <strong>לא לשמור טלפונים כאן.</strong>
    </div>`;

  return `
  <div class="info-box scaffold-note">
    ⚠️ העמוד הזה ייחסם למאסטר בלבד בשלב 6 (§7.1). כרגע הוא פתוח לכל מי שמגיעה
    לכתובת — לא לפרסם את הקישור לפני שההרשאות נבנות.
  </div>
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
    <span class="sett-desc">שלב 1 מתוך §14: מודל הנתונים וסנכרון חי. העמוד הזה קיים כדי
       שאפשר יהיה לראות שהמודל נטען נכון ושהסנכרון עובד — הוא לא חלק מהאתר הסופי.</span>
    <dl class="kv" style="margin-top:14px">
      <dt>מזהה הליגה</dt><dd><code class="num">tournaments/${escH(LEAGUE_ID)}</code></dd>
      <dt>קבוצות רשומות</dt><dd>${teams} <span class="muted">— הרשימה מתפרסמת אחרי 12.8.2026</span></dd>
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
      16 × 4 רשתות = 64 תאים; הלוז המלא תופס 60 (§4.3).</span>
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
    ${invalid ? `<span class="score-err">תוצאה לא חוקית — עד ${fmt.to}${fmt.cap ? `, תקרה ${fmt.cap}` : ', ללא תקרה'}, הפרש 2 (§10.1)</span>` : ''}
  </div>`;
}

function renderStandings() {
  const cats = L.categories.filter(c => (L.roster[c.id] || []).length >= 2);
  if (!cats.length) return `<div class="sett-section empty">
    <h3>אין עדיין דירוג</h3>
    <p>הדירוג יופיע כשיהיו קבוצות ומשחקים. רשימת הקבוצות מתפרסמת אחרי
       <strong>12.8.2026</strong>; אפשר להזין ידנית בעמוד <b>קבוצות</b> ואז ליצור לוז ב<b>מתזמן</b>.</p>
  </div>`;

  if (!standCat || !cats.find(c => c.id === standCat)) standCat = cats[0].id;

  const nav = `<div class="court-filter">${cats.map(c =>
    `<button class="cf-btn${c.id === standCat ? ' on' : ''}" data-act="stand.cat" data-cat="${escH(c.id)}">${escH(c.name)}</button>`
  ).join('')}</div>`;

  const { ranked, alerts } = rankStandings(standCat);

  const alertBox = alerts.map(a =>
    `<div class="sched-msg warn tie-alert">⚠ שוויון מלא בין ${a.size} קבוצות על מקומות
      <b class="num">${a.start === a.end ? a.start : a.start + '–' + a.end}</b>. התקנון לא מכריע —
      נדרשת החלטה ידנית${a.touchesF4 ? ' (נוגע לגבול הפיינל פור, מקומות 4–5)' : ''}.</div>`).join('');

  // הזנת התוצאות עברה לטאב "לוז" (שלב 5, §8) — כאן נשארת רק הטבלה החיה.
  return nav + standTable(ranked) + alertBox;
}

function standTable(ranked) {
  const rows = ranked.map(({ row, rank, tied }) => {
    const dc = row.diff > 0 ? 'diff-pos' : row.diff < 0 ? 'diff-neg' : 'diff-zero';
    const sign = row.diff > 0 ? '+' : '';
    return `<tr class="stand-row${rank <= 4 ? ' winner' : ''}${standTeam === row.id ? ' sel' : ''}"
        data-act="stand.team" data-id="${escH(row.id)}">
      <td class="num">${rank}${tied ? '<span class="tie-mark" title="שוויון לא מוכרע">=</span>' : ''}</td>
      <td class="stand-name">${escH(row.name)}</td>
      <td class="num">${row.played}</td>
      <td class="num">${row.wins}</td>
      <td class="num">${row.losses}</td>
      <td class="num">${row.tech || ''}</td>
      <td class="num">${row.noshow || ''}</td>
      <td class="num"><b class="stand-pts">${fmtPts(row.pts)}</b></td>
      <td class="num">${row.pf}</td>
      <td class="num">${row.pa}</td>
      <td class="num ${dc}">${sign}${row.diff}</td>
    </tr>`;
  }).join('');

  return `<div class="sett-section">
    <div class="tscroll"><table class="stbl stand-tbl">
      <thead><tr><th>#</th><th>קבוצה</th><th>מש׳</th><th>נצ׳</th><th>הפ׳</th>
        <th>טכני</th><th>היעדרות</th><th>נק׳</th><th>לזכות</th><th>לחובה</th><th>הפרש</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:10px">מיון לפי 3.10: נקודות ← הפרש ← מפגש ישיר ←
      מיני־ליגה (3 ומעלה). מקומות 1–4 מעפילים לפיינל פור (3.8). לחיצה על קבוצה מציגה את משחקיה בלבד.
      "טכני" ו"היעדרות" מפרטות הפסדי 0 נק׳ ואינן משפיעות על המיון.</span>
  </div>`;
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
  // שם שחקנית בסלוט. השם המאוחד (החלטה 8) נגזר מהשמות המלאים; זוג/שלישייה
  // נגזר ממספרם ולא נשמר.
  'team.player': el => {
    const f = findTeam(el.dataset.id); if (!f) return;
    const p = teamPlayers(f.team);
    p[+el.dataset.slot] = el.value.trim();
    f.team.players = p;
    f.team.name = p.filter(Boolean).join(' ');
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
  'stand.cat':       el => { standCat = el.dataset.cat; standTeam = null; },
  'stand.team':      el => { standTeam = standTeam === el.dataset.id ? null : el.dataset.id; },
  'stand.clearteam': () => { standTeam = null; },

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

  // ── סיסמאות ──
  'pw.admin':   el => hashPassword('adminPasswordHash', el),
  'pw.manager': el => hashPassword('managerPasswordHash', el),

  // ── בדיקת סנכרון (dev) ──
  'dev.name': el => { L.meta.name = el.value.trim(); }
};

// פעולות לוח הגרירה (שלב 5). כולן בקידומת board.* וכל אחת עושה queueSave/paint
// בעצמה, ולכן handle() לא שומר/מרנדר אותן אוטומטית (ראו התנאי ב-handle).
Object.assign(ACT, Board.ACT);

function confirmRegen() {
  const scored = (L.games || []).filter(g => g.result && g.result !== 'pending').length;
  if (!scored) return true;
  return confirm(`יש ${scored} משחקים עם תוצאה. הרצה מחדש שומרת תוצאה לכל משחק ` +
    `שנשאר אותו מפגש, אבל אם שינית את הרוסטר — תוצאות עלולות להימחק. להמשיך?`);
}

// רוסטר בדיקה. שמות אמיתיים באורך אמיתי, כדי שהגריד ייבדק בתנאים אמיתיים
// ולא מול "קבוצה 1". ?dev=1 בלבד, ורק מול futilina-test.
function seedTestRoster() {
  const first = ['רוני','טל','נועה','שירה','ליהי','עדי','מאיה','יערה','הילה','דנה',
                 'אור','ניצן','שקד','רותם','אביגיל','יובל','גאיה','תמר','אלה','נטע'];
  const pick = (i, k) => first[(i * 7 + k * 3) % first.length];
  const build = (cat, n) => Array.from({ length: n }, (_, i) => {
    // כל קבוצה שלישית = שלישייה (3 שמות), השאר זוגות (2 שמות)
    const players = i % 3 === 0 ? [pick(i, 0), pick(i, 1), pick(i, 2)] : [pick(i, 0), pick(i, 1)];
    return {
      id: `${CAT_PREFIX[cat]}t${String(i + 1).padStart(2, '0')}`,
      players, name: players.join(' '),
      active: true, withdrewAfterDay: null
    };
  });
  L.roster = { show: build('show', 6), liga1: build('liga1', 15), liga2: build('liga2', 15) };
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
  'sponsor.url', 'sponsor.alt'
]);

// פעולות שמשנות רק מה שמוצג ולא את המודל. בלי זה כל לחיצה על טאב של יום
// בעמוד המתזמן הייתה כותבת את המסמך כולו ל-Firestore — 240 משחקים על שינוי
// שקיים רק בדפדפן.
const NO_SAVE = new Set(['sched.day', 'stand.cat', 'stand.team', 'stand.clearteam']);

function handle(e, kinds) {
  const el = e.target.closest('[data-act]');
  if (!el || !kinds.test(el.tagName)) return;
  const act = el.dataset.act;
  const fn = ACT[act];
  if (!fn) return;
  const skip = fn(el, e) === false || NO_REPAINT.has(act);
  // פעולות board.* מנהלות שמירה ורינדור בעצמן (מטפל הלוח קורא ל-queueSave/paint
  // רק כשבאמת חל שינוי) — כדי שהחלפת תצוגה או בחירת יום לא יכתבו את המסמך כולו.
  if (!NO_SAVE.has(act) && !act.startsWith('board.')) queueSave();
  if (!skip) paintKeepScroll();   // שומר מיקום גלילה — הדף לא קופץ למעלה בכל פעולה
}

document.addEventListener('click',  e => {
  const tab = e.target.closest('[data-page]');
  if (tab) { page = tab.dataset.page; paint(); return; }
  // TR — שורת קבוצה בטבלת הדירוג לחיצה (§7.2: מציגה את משחקי הקבוצה)
  handle(e, /^(BUTTON|A|TR)$/);
});
document.addEventListener('change', e => handle(e, /^(INPUT|SELECT|TEXTAREA)$/));
// type=color בלבד — כל שאר השדות נשמרים ב-blur (מלכודת 3)
document.addEventListener('input',  e => {
  if (e.target.type === 'color') handle(e, /^INPUT$/);
});
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
  paint();
  setSync('ok');
})();
