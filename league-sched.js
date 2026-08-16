// ============================================================================
// league-sched.js — המתזמן. שלב 3 מתוך §14 במפרט.
//
// שלושת השלבים של §6.1, כל אחד ניתן להרצה בנפרד:
//   א׳  buildRoundRobin  — שיטת המעגל. דטרמיניסטי, לכל N, זוגי או אי־זוגי
//   ב׳  splitIntoDays    — חלוקת המשחקים לימים שווים
//   ג׳  packDay          — אריזה לגריד (סלוט × רשת) + פאס תיקון
// ופונקציית העלות של §6.2: dayCost.
//
// ❗ הקובץ הזה **טהור**: אין בו import, אין DOM ואין Firestore. זה מכוון.
//    כך אפשר להריץ את כל האלגוריתם ב-Node מול רוסטרים סינתטיים ולבדוק את כל
//    האילוצים בלי לגעת בשום דוק (מלכודת 6). league.js הוא היחיד שמחבר אותו
//    למודל ולמסך.
//
// ⚠️ אין כאן שום מספר שקשור ל-15 קבוצות, ל-4 רשתות או ל-16 סלוטים. כל אלה
//    נגזרים מהקלט. המספרים של §4.2–§4.3 הם תוצאה של האלגוריתם, לא קלט לו.
// ============================================================================

'use strict';

// ============================================================================
// עזרים
// ============================================================================

const hhmmToMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const minToHhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// סלוט 1 מתחיל בשעת ההתחלה של היום (1-based, כמו ב-league.js).
export const slotStartMin = (day, s) => hhmmToMin(day.startTime) + (s - 1) * day.slotMin;
export const slotLabel    = (day, s) => minToHhmm(slotStartMin(day, s));
export const dayEndLabel  = (day, lastSlot) => minToHhmm(hhmmToMin(day.startTime) + lastSlot * day.slotMin);

// מחולל מספרים דטרמיניסטי. Math.random היה הופך כל הרצה לשונה — ואז
// "סדר לי את היום מחדש" (§8.6) לא היה חוזר על עצמו, ובאג לא היה ניתן לשחזור.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// מזהה לוגי של משחק: מי נגד מי, באיזו ליגה, ובאיזה מפגש (rr:2 → שני מפגשים).
// זהו המפתח שלפיו הרצה חוזרת מזהה משחק קיים ושומרת את התוצאה ואת הנעילה שלו —
// ולא לפי id, שיכול להתחלף אם הרוסטר השתנה.
//
// ⚠️ שני המזהים **ממוינים**. ב-RR הצד שנקרא a והצד שנקרא b הוא תוצר שרירותי
// של מיקום הקבוצה במעגל, ולא עובדה על המשחק. בלי המיון, קבוצה אחת שפורשת
// (6.1) מסובבת את המעגל, חצי מהזוגות מתהפכים, והמפתחות שלהם משתנים — נמדד:
// 40 תוצאות שהוזנו נמחקו בשקט בהרצה חוזרת. leg הוא מה שמבדיל בין שני המפגשים
// של סיבוב כפול, ולכן הוא זה שנושא את ההבחנה ולא סדר השמות.
export const gameKey = (cat, a, b, leg) =>
  `${cat}|${a < b ? a + '|' + b : b + '|' + a}|${leg}`;

// ============================================================================
// §6.2 — משקלי פונקציית העלות (טבלת העלות המעודכנת)
// ============================================================================
//
// "∞" מיוצג כמספר סופי גדול, במכוון. אינסוף אמיתי היה הופך כל מצב לא־חוקי
// לשווה־ערך לכל מצב לא־חוקי אחר, והחיפוש המקומי לא היה יכול לרדת מ-3 הפרות
// ל-2. hard=1e6 גדול בסדר גודל מכל סכום רך אפשרי ולכן שומר על הסדר: כל הפרה
// קשיחה גוברת על כל צירוף של הפרות רכות.
//
// ⚠️ עדכון §6.2: שיפוט (5.2/5.3) ושאו-על-רשת-1 **ירדו מקשיח לרך**. אילוץ קשיח
//    נשאר רק לארבעה: קבוצה בשני משחקים באותו סלוט, שתי קבוצות על אותו תא, תא
//    חסום, וחלון זמינות. כל השאר רך והמתזמן ממטב את הסכום.
//
// המשקלים הם **נקודות פתיחה** (§6.2/§6.3): אחרי יצירת לוז מסתכלים על אורך
// היום / רצפים / חורים / המתנות ומכווננים. סדר הטבלה — מהחשוב לפחות:
export const WEIGHTS = {
  hard:        1_000_000,   // ארבעת האילוצים הקשיחים של §6.2

  // ── רצף ──
  // ליגה ב׳ (allowConsecutive): 2 משחקים ברצף = מותר, עלות 0 (streakLiga2Pair);
  // מהמשחק ה-3 ברצף = 5000. שאו / ליגה א׳: כל רצף (כבר מהזוג) = 1000 (רך — היה קשיח).
  // streakLiga2Pair הוא **כפתור הכיוונון** ל"כמה נדיר יהיה רצף בליגה ב׳": 0 =
  // §6.2 כלשונה (רצף שכיח, ~15/מחזור, לוז הכי הדוק); 100 = נדיר (~9/עונה); 200 →
  // ~4/עונה. נבחר **100** (החלטת המשתמשת 25.7): רצף ליגה ב׳ נדיר, במחיר זעום —
  // 4 חורים נוספים ומחזור 1 ב-22:20 במקום 22:00. שאו/א׳ נשארות 0 רצף.
  streakLiga2:     5_000,
  streakLiga2Pair:   100,
  // רצף שאו/א׳ = לוק **קשיח** (החלטת המשתמשת 25.7): גבוה מכל קנס רך אחר (כולל
  // סיום-מאוחר), כך שהדחיסה לסיום מוקדם לעולם לא "קונה" רצף שאו/א׳. מתחת ל-hard
  // כדי שאילוצים קשיחים אמיתיים עדיין גוברים.
  streak:        100_000,

  noReferee:       800,   // אין שופטת (5.2/5.3) — רך, היה קשיח

  // ── שחקנית משותפת לשתי קבוצות (§5.4, שלב 2) ──
  // input.links = זוגות קבוצות שחולקות שחקנית (נקבע ברוסטר, §5.4 שלב 1).
  // **מקביל** (אותו סלוט) = אילוץ **קשיח** תמיד, ולכן אין לו משקל משלו — הוא
  // נספר תחת `hard`. שחקנית לא יכולה להיות בשני מקומות; זוג או שלישייה לא
  // משנה, האילוץ הוא ברמת הקבוצה (החלטת המשתמשת).
  // **רצף** (סלוטים עוקבים) = אזהרה רכה: 6–7 משחקים בערב זה כבר הרבה, אבל זה
  // אפשרי. גבוה בטבלה (מעל רצף-קטגוריה 500 והמתנה 300), אך **מתחת ל-lateFinish
  // (2000)** במכוון — סיום מוקדם נשאר המטרה העליונה (הלוק של 25.7), והאזהרה
  // הזאת לא קונה לוז ארוך יותר. נמדד: 800 עומד בכל הלוקים; ראו יומן §5.4 שלב 2.
  linkedAdjacent:  800,
  catReturn:       500,   // רצף קטגוריה לא נקי על רשת — קטגוריה חוזרת אחרי שעזבה (א׳→ב׳→א׳)
  wait4:           300,   // המתנה של 4+ סלוטים בין משחקי קבוצה
  gamesOver:       200,   // יותר מהמכסה העליונה ביום
  gamesUnder:      200,   // פחות מהמכסה התחתונה ביום
  showNotNet1:     150,   // שאו לא על הרשת המועדפת (רך בינוני, לא חובה)
  lateFinish:     2000,   // × מרחק — סיום מאוחר. **המטרה העליונה (25.7):** לסיים מוקדם
                          // (לקפל רשתות). גבוה מ-togetherness/זוגות/המתנה — מנצח אותם;
                          // נמוך מרצף שאו/א׳ — לא קונה רצף. דוחף לדחוס ל-15 סלוטים = 22:00.
  emptyEarly:       40,   // × מוקדמוּת — חור בסלוט מוקדם (חורים צריכים להתרכז בסוף)
  fairness:         40,   // הוגנות מוקדם/מאוחר — קבוצה שמקבלת שוב את הסלוט הראשון/אחרון (חוצה-ימים)
  wait3:            30,   // המתנה של 3 סלוטים (1–2 = אידיאלי, עלות 0)
  span:             10,   // טווח הנוכחות של הקבוצה ביום
  netSpread:        10    // קפיצות רשת — קבוצה על הרבה רשתות שונות באותו יום
};

// ============================================================================
// שלב א׳ — יצירת מחזורי RR (§6.1.א)
// ============================================================================
//
// שיטת המעגל: קבוצה אחת נשארת במקומה והשאר מסתובבות סביבה. N אי־זוגי → מוסיפים
// BYE מדומה, מקבלים N מחזורים ובכל אחד ⌊N/2⌋ משחקים, וכל קבוצה יושבת בדיוק
// פעם אחת בעונה — זה ה-bye של §6.3. N זוגי → N-1 מחזורים, N/2 משחקים, בלי bye.
//
// legs=2 (ליגת שואו, החלטה 5) מריץ את המעגל פעמיים; בסיבוב השני a ו-b
// מתחלפים, כך ששני המפגשים ניתנים להבחנה בתצוגה ובדפי ההדפסה.

export const BYE = '__bye__';

export function buildRoundRobin(teamIds, legs = 1) {
  const n = teamIds.length;
  if (n < 2) return [];

  const base = n % 2 ? [...teamIds, BYE] : [...teamIds];
  const m = base.length, half = m / 2;
  const rounds = [];

  for (let leg = 0; leg < legs; leg++) {
    const arr = [...base];
    for (let r = 0; r < m - 1; r++) {
      const games = [], byes = [];
      for (let i = 0; i < half; i++) {
        const x = arr[i], y = arr[m - 1 - i];
        if (x === BYE) { byes.push(y); continue; }
        if (y === BYE) { byes.push(x); continue; }
        games.push(leg % 2 ? { a: y, b: x } : { a: x, b: y });
      }
      rounds.push({ index: rounds.length, leg, games, byes });
      arr.splice(1, 0, arr.pop());   // הסיבוב: הראשונה קבועה, השאר זזות
    }
  }
  return rounds;
}

// כל המשחקים של קטגוריה כרשימה שטוחה, בסדר המחזורים.
export function roundsToGames(catId, rounds) {
  const out = [];
  for (const r of rounds)
    for (const g of r.games)
      out.push({ key: gameKey(catId, g.a, g.b, r.leg), cat: catId,
                 a: g.a, b: g.b, round: r.index, leg: r.leg });
  return out;
}

// ============================================================================
// שלב ב׳ — חלוקת המשחקים לימים (§6.1.ב)
// ============================================================================
//
// מחזורי RR **מותר לפצל בין ימים** (3.6 מתיר 1–5 משחקים לקבוצה במחזור), וזה
// בדיוק מה שמאפשר ימים שווים. שני יעדים:
//   1. מספר משחקים זהה בכל יום — לכל ליגה בנפרד, והשאריות מתחלקות כך שגם
//      **הסכום** של היום יישאר מאוזן.
//   2. כל קבוצה מקבלת [lo,hi] משחקים ביום, כאשר lo=⌊משחקיה/ימים⌋ ו-hi=⌈…⌉.
//      ל-15 קבוצות ב-4 ימים זה יוצא בדיוק 3–4 כמו ב-§4.4 וב-§6.2, ולשואו
//      (10 משחקים ב-4 ימים) זה יוצא 2–3 — נכון יותר מקיבוע ל-3/4.
//
// ה-bye כמנוף (§6.3): קבוצה עם חלון זמינות צר ביום מסוים מקבלת שם משקל
// `tight` שדוחף אותה לפחות משחקים באותו יום. כשמחזורי RR מפוצלים בין ימים
// "לתת לה את ה-bye ביום הבעייתי" *הוא* "לתת לה פחות משחקים באותו יום":
// הקבוצה יושבת מחזור אחד בעונה, והמחזור הזה נוחת ביום שבו היא צפופה.

export function splitIntoDays(cats, dayIds, opts = {}) {
  const locked = opts.locked || {};      // { gameKey: dayId } — לא זזים (§6.3)
  const tight  = opts.tight  || {};      // { dayId: { teamId: 0..1 } }
  const D = dayIds.length;

  const assign   = {};                                            // key → dayId
  const quotas   = {};                                            // catId → {dayId:n}
  const teamDay  = {};                                            // teamId → {dayId:n}
  const dayTotal = Object.fromEntries(dayIds.map(d => [d, 0]));   // סכום כל הליגות

  if (!D) return { assign, quotas, teamDay, dayTotal, warnings: ['אין ימי ליגה סדירה.'] };

  const zeroDays = () => Object.fromEntries(dayIds.map(d => [d, 0]));
  const bump = (t, d, k = 1) => { (teamDay[t] ||= zeroDays())[d] += k; };

  const ordered = [...cats].sort((a, b) => (a.order || 0) - (b.order || 0));

  // חלוקת מערך הימים ל-k תת-קבוצות רציפות שוות.
  const partition = (arr, k) => Array.from({ length: k }, (_, i) =>
    arr.slice(Math.round(i * arr.length / k), Math.round((i + 1) * arr.length / k)));

  // הקצאת משחקים (של סבב אחד, או של ליגה שלמה) לתת-קבוצת ימים: מכסות שוות +
  // חמדני. הקריטריון הראשי הוא כמה משחקים כבר יש לשתי הקבוצות ביום — כך כל
  // קבוצה מתפזרת על פני הימים ולא מתרכזת באחד. דטרמיניסטי, בלי לולאות חסרות-חסם.
  const assignLeg = (catId, games, days) => {
    if (!games.length) return;
    const n = games.length, k = days.length;
    const q = Object.fromEntries(days.map(d => [d, Math.floor(n / k)]));
    [...days].sort((x, y) => (dayTotal[x] - dayTotal[y]) || (dayIds.indexOf(x) - dayIds.indexOf(y)))
      .slice(0, n % k).forEach(d => q[d]++);
    (quotas[catId] ||= {});
    for (const d of days) { quotas[catId][d] = (quotas[catId][d] || 0) + q[d]; dayTotal[d] += q[d]; }

    const used = Object.fromEntries(days.map(d => [d, 0]));
    const rest = [];
    for (const g of games) {
      const d = locked[g.key];
      if (d && days.includes(d)) { assign[g.key] = d; used[d]++; bump(g.a, d); bump(g.b, d); }
      else rest.push(g);
    }
    for (const g of rest) {
      let best = null;
      for (const d of days) {
        if (used[d] >= q[d]) continue;
        const load = (teamDay[g.a]?.[d] || 0) + (teamDay[g.b]?.[d] || 0);
        const tg   = (tight[d]?.[g.a] || 0) + (tight[d]?.[g.b] || 0);
        const score = load * 1000 + tg * 300 + used[d];
        if (!best || score < best.score) best = { d, score };
      }
      const d = best ? best.d : days.reduce((x, y) => used[x] <= used[y] ? x : y);
      assign[g.key] = d; used[d]++; bump(g.a, d); bump(g.b, d);
    }
  };

  for (const cat of ordered) {
    if (!cat.games.length) continue;

    // סבב כפול (שואו, החלטה 5): כל סבב שלם על **חצי-ימים נפרד** → אף זוג לא
    // נפגש פעמיים באותו יום, וסבב 1 מסתיים לפני שסבב 2 מתחיל (בקשת המשתמשת).
    // מוחל רק כשהימים מתחלקים שווה במספר הסבבים ואין חלון-זמינות על קבוצות
    // הליגה — אחרת נופלים לסיבוב יחיד על כל הימים (הפרדה קפדנית + זמינות/מעט
    // ימים היו יוצרים עומס לא ישים). דטרמיניסטי.
    const numLegs = Math.max(0, ...cat.games.map(g => g.leg || 0)) + 1;
    const hasAvail = (cat.teams || []).some(t => dayIds.some(d => tight[d]?.[t]));
    if (numLegs > 1 && D % numLegs === 0 && D >= numLegs && !hasAvail) {
      const groups = partition(dayIds, numLegs);
      for (let leg = 0; leg < numLegs; leg++)
        assignLeg(cat.id, cat.games.filter(g => (g.leg || 0) === leg), groups[leg]);
    } else {
      assignLeg(cat.id, cat.games, dayIds);
    }

    balanceTeamDays(cat, dayIds, assign, teamDay, locked);
  }

  return { assign, quotas, teamDay, dayTotal, warnings: [] };
}

// פאס תיקון לחלוקה: קבוצה שיצאה מחוץ ל-[lo,hi] ביום כלשהו מוחלפת פנימה.
// ההחלפה היא תמיד בין שני משחקים של אותה ליגה — כך המכסות היומיות נשמרות
// בדיוק, וההחלפה לא הורסת את האיזון שהושג ברמת היום.
function balanceTeamDays(cat, dayIds, assign, teamDay, locked) {
  const D = dayIds.length;
  const total = {};
  for (const t of cat.teams) total[t] = 0;
  for (const g of cat.games) { total[g.a] = (total[g.a] || 0) + 1; total[g.b] = (total[g.b] || 0) + 1; }

  const lo = t => Math.floor((total[t] || 0) / D);
  const hi = t => Math.ceil((total[t] || 0) / D);
  const pen = (t, d) => {
    const c = teamDay[t]?.[d] || 0;
    return Math.max(0, c - hi(t)) + Math.max(0, lo(t) - c);
  };

  const movable = cat.games.filter(g => !locked[g.key]);

  for (let pass = 0; pass < 400; pass++) {
    let fixed = false;

    for (const t of cat.teams) {
      const td = teamDay[t]; if (!td) continue;
      if (!dayIds.some(d => pen(t, d) > 0)) continue;

      // ⚠️ לא "היום שחורג מ-hi" אלא "היום העמוס ביותר". קבוצה עם 1·3·3·3
      // (סה״כ 10, hi=3) לא חורגת באף יום ובכל זאת יש לה יום עם משחק אחד;
      // בלי זה שום החלפה לא הייתה נבחנת והיא הייתה נשארת ככה.
      const dOver  = dayIds.reduce((x, y) => td[y] > td[x] ? y : x);
      const dUnder = dayIds.reduce((x, y) => td[y] < td[x] ? y : x);
      if (dOver === dUnder) continue;

      const mine   = movable.filter(g => assign[g.key] === dOver  && (g.a === t || g.b === t));
      const others = movable.filter(g => assign[g.key] === dUnder && g.a !== t && g.b !== t);

      let done = false;
      for (const g of mine) {
        for (const h of others) {
          // רק החלפה בין משחקים של אותו סבב — כדי לא לזלוג סבב לחצי-הימים של
          // סבב אחר ולשמור על הפרדת הסבבים של שואו. לליגה של סבב יחיד כל
          // המשחקים בסבב 0, ולכן זה תמיד עובר (בלי השפעה).
          if ((g.leg || 0) !== (h.leg || 0)) continue;
          const touched = [[g.a, dOver], [g.b, dOver], [h.a, dUnder], [h.b, dUnder],
                           [g.a, dUnder], [g.b, dUnder], [h.a, dOver], [h.b, dOver]];
          const before = touched.reduce((s, [x, d]) => s + pen(x, d), 0);
          swap(g, h);
          if (touched.reduce((s, [x, d]) => s + pen(x, d), 0) < before) { done = true; break; }
          swap(h, g);   // חזרה
        }
        if (done) break;
      }
      if (done) fixed = true;
    }
    if (!fixed) break;
  }

  function swap(g, h) {   // g עובר ליומו של h ולהפך
    const dg = assign[g.key], dh = assign[h.key];
    assign[g.key] = dh; assign[h.key] = dg;
    for (const t of [g.a, g.b]) { teamDay[t][dg]--; teamDay[t][dh]++; }
    for (const t of [h.a, h.b]) { teamDay[t][dh]--; teamDay[t][dg]++; }
  }
}

// ============================================================================
// שלב ג׳ — אריזה לגריד (§6.1.ג)
// ============================================================================
//
// ⚙️ ייצוג פנימי: השיבוץ הוא **שני Int32Array לפי אינדקס משחק** ולא Map —
//    `pl.slot[i]` ו-`pl.net[i]`, 0 = לא משובץ. פאס התיקון מריץ עשרות אלפי
//    הערכות עלות, ובגרסה עם Map ואובייקטים כל הערכה הקצתה זיכרון והרצה אחת
//    לקחה דקות. עם מערכים ההערכה היא ~1500 פעולות בלי הקצאה בכלל.
//    ההמרה ל-Map קורית פעם אחת, בגבול של packDay.

// ── חלון זמינות → טווח סלוטים ──
// notBefore: המשחק לא יכול *להתחיל* לפני. notAfter: המשחק חייב *להסתיים* עד —
// קבוצה שעוזבת ב-20:00 לא יכולה לשחק סלוט שנגמר ב-20:20.
export function availWindow(day, av) {
  const start = hhmmToMin(day.startTime);
  let from = 1, to = day.slots;
  if (av?.notBefore) from = Math.max(1, Math.ceil((hhmmToMin(av.notBefore) - start) / day.slotMin) + 1);
  if (av?.notAfter)  to   = Math.min(day.slots, Math.floor((hhmmToMin(av.notAfter) - start) / day.slotMin));
  return { from, to };
}

// ── התוכנית: כמה משחקים לכל ליגה בכל סלוט ──
//
// ⚠️ נבדק אמפירית (24–25.7): אריזה **צפופה** (מילוי כל סלוט → בלי חורים) מפוצצת
// את ההמתנות — 60 קבוצות ממתינות 3+ סלוטים, חלקן 5 (100 דק׳), והיום לא מתקצר.
// זה מוכיח את המתח: ל-15 קבוצות על 4 רשתות אי אפשר גם בלי חורים וגם המתנה קצרה.
// ה-4 "חורים"/יום הם רשת שנחה 20 דק׳ (אף שחקנית לא נפגעת); לצמצם אותם = שחקניות
// עומדות שעה. לכן נשמרת האריזה המאוזנת: קצב שמצמצם המתנה, עם ~4 תאים ריקים.
//
// הליגות נארזות קדימה לפי הסדר; g(S)+g(S+1) ≤ ⌊N/2⌋ (אי-רצף) מייצר את הקצב.
export function planSlotCounts(ctx, opts = {}) {
  const S = ctx.slots;
  // ליגות במקביל (בקשת המשתמשת 25.7): במקום לארוז כל ליגה קדימה בבלוק-זמן משלה
  // (שגרם לליגה א׳ מוקדם וליגה ב׳ מאוחר — לא ביחד), מפזרים כל ליגה **על פני כל
  // היום** בקצב אחיד (משחקיה שנותרו ÷ הסלוטים שנותרו). כך שתיהן נוכחות בכל סלוט
  // ורצות במקביל — כולן ביחד בחוף. שאו (fixedNet) נשאר ~1/סלוט מוקדם.
  const spread = opts.spreadLeagues !== false;   // ברירת מחדל: במקביל
  const free = [];       // free[s-1] = Set של רשתות פנויות בסלוט s
  for (let s = 1; s <= S; s++)
    free.push(new Set(ctx.netIds.filter(n => !ctx.blocked.has(s + '|' + n))));

  // משחקים נעולים תופסים תא ומצטמצמים מהמכסה של הליגה שלהם
  const lockedAt = {};   // catId → Map(slot → count)
  for (const g of ctx.games) {
    if (!g.locked || !g.slot || !g.net) continue;
    free[g.slot - 1]?.delete(g.net);
    (lockedAt[g.cat] ||= new Map()).set(g.slot, (lockedAt[g.cat].get(g.slot) || 0) + 1);
  }

  const plan = {}, overflow = {};

  for (const cat of catOrder(ctx)) {
    const mine = ctx.games.filter(g => g.cat === cat.id);
    const pairCap = Math.max(1, Math.floor((cat.teams?.length || 0) / 2));   // ⌊N/2⌋
    const lk = lockedAt[cat.id] || new Map();
    let remaining = mine.filter(g => !g.locked).length;

    // נבדק (25.7): לארוז את השואו מהסוף (כדי שיסגור את הערב) העלה את ההמתנות
    // (w3 21→28, מקס 3→4). המשתמשת בחרה באיזון־המתנה, לכן השואו נשאר מוקדם.
    const p = new Array(S).fill(0);
    let prev = 0;
    for (let s = 1; s <= S; s++) {
      const already = lk.get(s) || 0;
      // §6.2: שאו כבר לא **נעול** לרשת המועדפת — זו העדפה רכה (150). כדי לשמור
      // על חלון-השאו הנקי והמוקדם (§4.3) הוא עדיין נארז ~1/סלוט, אבל אם הרשת
      // המועדפת תפוסה הוא כן מקבל רשת אחרת (במקום להיחסם כמו קודם).
      let allowed = cat.fixedNet ? (free[s - 1].size ? 1 : 0) : free[s - 1].size;
      // ליגות במקביל: מגבילים כל ליגה גדולה ל~חצי הרשתות בסלוט, כך ששתי הליגות
      // חולקות את הרשתות ורצות במקביל (כולן ביחד), בלי שאחת תתפוס את כל הרשתות
      // מוקדם. חצי-רשתות (ולא פיזור על כל היום) שומר על חלון דחוס להמתנות קצרות.
      if (spread && !cat.fixedNet) {
        allowed = Math.min(allowed, Math.max(1, Math.round(ctx.netIds.length / 2)));
      }
      const take = Math.max(0, Math.min(allowed, pairCap - prev - already, remaining));
      p[s - 1] = already + take;
      prev = p[s - 1];
      remaining -= take;

      if (take > 0) {
        // רק המספרים חשובים כאן; הרשת האמיתית נבחרת ב-greedyFill. הרשת המועדפת
        // נמחקת ראשונה כך שהיא תישאר לשאו כשאפשר.
        const nets = orderNets([...free[s - 1]], cat.fixedNet);
        for (let i = 0; i < take && i < nets.length; i++) free[s - 1].delete(nets[i]);
      }
    }
    plan[cat.id] = p;
    if (remaining > 0) overflow[cat.id] = remaining;
  }

  return { plan, overflow };
}

const catOrder = ctx => [...ctx.cats].sort((a, b) =>
  (a.fixedNet ? 0 : 1) - (b.fixedNet ? 0 : 1) || (a.order || 0) - (b.order || 0));

// סדר רשתות עם הרשת המועדפת (אם יש) בראש — כך שאו מקבל אותה קודם, אבל שאר
// הרשתות זמינות לו כשהמועדפת תפוסה. בלי רשת מועדפת הסדר נשמר כמו שהוא.
const orderNets = (list, pref) =>
  pref ? [...list].sort((a, b) => (a === pref ? 0 : 1) - (b === pref ? 0 : 1)) : list;

// ============================================================================
// המבנים המהירים — נבנים פעם אחת לכל ctx ומשמשים את כל הערכות העלות
// ============================================================================
function scratch(ctx) {
  if (ctx._s) return ctx._s;

  // כל הקבוצות של כל הליגות שמשחקות ביום, גם כאלה שלא קיבלו אף משחק —
  // אחרת "קבוצה בלי אף משחק ביום" (§9) לא הייתה נבדקת בכלל.
  const teams = [...new Set([
    ...ctx.cats.flatMap(c => c.teams || []),
    ...ctx.games.flatMap(g => [g.a, g.b])
  ])];
  const ti = new Map(teams.map((t, i) => [t, i]));
  const S = ctx.slots, T = teams.length;
  const nets = ctx.netIds, N = nets.length;
  const netPos = new Map(nets.map((n, i) => [n, i]));

  const blocked = new Uint8Array((S + 2) * N);
  for (const k of ctx.blocked) {
    const [s, n] = k.split('|').map(Number);
    const p = netPos.get(n);
    if (p != null && s >= 1 && s <= S) blocked[s * N + p] = 1;
  }

  const availFrom = new Int32Array(T).fill(1);
  const availTo   = new Int32Array(T).fill(S);
  for (const [t, w] of Object.entries(ctx.avail || {})) {
    const i = ti.get(t); if (i == null) continue;
    availFrom[i] = w.from; availTo[i] = w.to;
  }

  const lo = new Int32Array(T), hi = new Int32Array(T).fill(9999);
  for (const [t, b] of Object.entries(ctx.bounds || {})) {
    const i = ti.get(t); if (i == null) continue;
    lo[i] = b.lo || 0;
    hi[i] = Number.isFinite(b.hi) ? b.hi : 9999;
  }

  const G = ctx.games.length;
  const gA = new Int32Array(G), gB = new Int32Array(G);
  const gFixedNet = new Int32Array(G);          // 0 = ללא רשת קבועה
  const gLocked = new Uint8Array(G);
  const gCat = new Int32Array(G);               // אינדקס הליגה (1-based) — לקוהרנטיות רשת
  const catIdx = new Map(ctx.cats.map((c, i) => [c.id, i + 1]));
  const fixedOf = new Map(ctx.cats.map(c => [c.id, c.fixedNet || 0]));
  const teamGames = Array.from({ length: T }, () => []);
  for (let i = 0; i < G; i++) {
    const g = ctx.games[i];
    gA[i] = ti.get(g.a); gB[i] = ti.get(g.b);
    gFixedNet[i] = fixedOf.get(g.cat) || 0;
    gCat[i] = catIdx.get(g.cat) || 0;
    gLocked[i] = g.locked ? 1 : 0;
    teamGames[gA[i]].push(i); teamGames[gB[i]].push(i);
  }

  // דגל "רצף מותר" לכל קבוצה — ליגה עם allowConsecutive (ליגה ב׳) בלבד. הרצף
  // שלה מטופל אחרת (זוג חינם, 3+ = streakLiga2); לשאר הליגות כל רצף = streak.
  const allowConsec = new Uint8Array(T);
  for (const c of ctx.cats) {
    if (!c.allowConsecutive) continue;
    for (const t of c.teams || []) { const i = ti.get(t); if (i != null) allowConsec[i] = 1; }
  }

  // הוגנות מוקדם/מאוחר (§6.2, חוצה-ימים): כמה ימים קודם כבר קיבלה הקבוצה סלוט
  // קיצון (ראשון/אחרון). מוזרק מבחוץ ע"י generateSeason; ריק בקריאה בודדת.
  const fairPrior = new Int32Array(T);
  for (const [t, k] of Object.entries(ctx.extremesPrior || {})) {
    const i = ti.get(t); if (i != null) fairPrior[i] = k | 0;
  }

  // ── קבוצות שחולקות שחקנית (§5.4) ──
  // ctx.linked = זוגות מזהי קבוצות שיש להן שחקנית משותפת (נקבע ברוסטר).
  // שתי צורות, כי שני צרכנים שונים: `linked` (זוגות אינדקסים) לפונקציית העלות,
  // ו-`partners` (רשימת שכנות לכל אינדקס) לבדיקות הנקודתיות באריזה — שם השאלה
  // תמיד "מי אסור לי בסלוט הזה?" ולא "עברי על כל הזוגות".
  // ⚠️ קבוצה יכולה לחלוק שחקניות עם **יותר מקבוצה אחת** (שלישייה שבה שתי
  // שחקניות שונות משחקות כל אחת בליגה אחרת), ולכן זו רשימה ולא שדה יחיד.
  // ⚠️ הזוגות **ממוינים ומנורמלים** (min,max ואז מיון), מאותה סיבה ש-gameKey
  // ממוין: הצד שנקרא a הוא שרירותי. פאס התיקון סורק מועמדים בסדר הכנסתם, ולכן
  // בלי הנרמול אותו רוסטר בדיוק היה נותן לוז אחר רק כי הרוסטר החזיר את הזוג
  // בכיוון ההפוך (נמדד: 16 משחקים בתא אחר, ואפילו עלות שונה).
  const linked = [];
  const partners = Array.from({ length: T }, () => []);
  const seenPair = new Set();
  for (const [a, b] of ctx.linked || []) {
    const x = ti.get(a), y = ti.get(b);
    if (x == null || y == null || x === y) continue;
    const ia = Math.min(x, y), ib = Math.max(x, y), k = ia + '|' + ib;
    if (seenPair.has(k)) continue;                    // זוג כפול בקלט — פעם אחת
    seenPair.add(k);
    linked.push([ia, ib]);
  }
  linked.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [ia, ib] of linked) { partners[ia].push(ib); partners[ib].push(ia); }

  return ctx._s = {
    teams, ti, T, S, nets, N, netPos, blocked, availFrom, availTo, lo, hi,
    allowConsec, fairPrior, linked, partners,
    G, gA, gB, gFixedNet, gCat, gLocked, teamGames,
    tc:       new Int32Array(T * (S + 2)),      // קבוצה × סלוט
    cc:       new Int32Array((S + 2) * N),      // סלוט × רשת — כמה משחקים
    cellCat:  new Int32Array((S + 2) * N),      // סלוט × רשת — איזו ליגה (לקוהרנטיות)
    teamNets: new Int32Array(T)                 // קבוצה → מסכת ביטים של הרשתות ששיחקה בהן (netSpread)
  };
}

export function emptyPlacement(ctx) {
  const G = ctx.games.length;
  return { slot: new Int32Array(G), net: new Int32Array(G) };
}

// ============================================================================
// §6.2 — פונקציית העלות
// ============================================================================
//
// collect=false מחזיר מספר בלבד ולא מקצה כלום — זו הצורה שרצה בפאס התיקון.
// collect=true מוסיף את רשימת ההפרות, וזו הצורה שמזינה את סרגל האזהרות (§9).
function evalDay(pl, ctx, collect) {
  const s = scratch(ctx), W = WEIGHTS;
  const { T, S, N, tc, cc, cellCat, blocked, availFrom, availTo, lo, hi,
          gA, gB, gFixedNet, gCat, allowConsec, fairPrior, teamNets } = s;

  tc.fill(0); cc.fill(0); cellCat.fill(0); teamNets.fill(0);
  let lastSlot = 0, placed = 0;

  for (let i = 0; i < s.G; i++) {
    const slot = pl.slot[i]; if (!slot) continue;
    placed++;
    if (slot > lastSlot) lastSlot = slot;
    const np = s.netPos.get(pl.net[i]);
    if (np != null) {
      cc[slot * N + np]++; cellCat[slot * N + np] = gCat[i];
      if (np < 31) { const bit = 1 << np; teamNets[gA[i]] |= bit; teamNets[gB[i]] |= bit; }
    }
    tc[gA[i] * (S + 2) + slot]++;
    tc[gB[i] * (S + 2) + slot]++;
  }

  let hard = 0, streak = 0, gamesOver = 0, gamesUnder = 0, wait = 0, span = 0,
      catReturn = 0, noReferee = 0, showNet = 0, lateFinish = 0, emptyEarly = 0,
      fairness = 0, netSpread = 0, linkedAdjacent = 0;
  const V = collect ? [] : null;

  // ── לפי קבוצה: הקשיח "פעמיים באותו סלוט", הרצף, ההמתנה, המכסה, הטווח,
  //    ההוגנות ופיזור-הרשתות — הכול במעבר אחד ──
  for (let t = 0; t < T; t++) {
    const base = t * (S + 2);
    let prev = 0, first = 0, last = 0, n = 0, run = 0;
    for (let sl = 1; sl <= S; sl++) {
      const c = tc[base + sl];
      if (!c) continue;
      if (c > 1) {
        hard += W.hard * (c - 1);
        if (V) V.push({ kind:'doubleBooked', cost:W.hard*(c-1), slot:sl, team:s.teams[t],
                        text:`${s.teams[t]} משובצת ל-${c} משחקים באותו סלוט` });
      }
      if (sl < availFrom[t] || sl > availTo[t]) {
        hard += W.hard * c;
        if (V) V.push({ kind:'availability', cost:W.hard*c, slot:sl, team:s.teams[t],
                        text:`${s.teams[t]} משובצת מחוץ לחלון הזמינות שביקשה` });
      }
      n += c;
      if (!first) first = sl;
      if (prev) {
        const gap = sl - prev;
        if (gap === 1) {
          // run = מספר המעברים-ברצף הרצופים עד כה. run==1 → זוג (משחק שני ברצף);
          // run>=2 → המשחק ה-3 ומעלה. ליגה ב׳: הזוג חינם, מהשלישי 5000. שאר
          // הליגות: כל מעבר-רצף = 1000 (רך).
          run++;
          // ליגה ב׳: זוג (run==1) → streakLiga2Pair (0 כברירת מחדל); משחק 3+
          // (run>=2) → streakLiga2. שאר הליגות → streak על כל רצף.
          const cst = allowConsec[t] ? (run >= 2 ? W.streakLiga2 : W.streakLiga2Pair) : W.streak;
          if (cst) {
            streak += cst;
            if (V) V.push({ kind:'backToBack', cost:cst, slot:prev, team:s.teams[t],
                            text: !allowConsec[t] ? `${s.teams[t]} משחקת פעמיים ברצף`
                                 : run >= 2        ? `${s.teams[t]} משחקת 3 פעמים ברצף`
                                                   : `${s.teams[t]} משחקת פעמיים ברצף (ליגה ב׳)` });
          }
        } else {
          run = 0;
          const w = gap - 1;   // מספר הסלוטים הריקים בין שני המשחקים
          // המתנה 1–2 = אידיאלי (0). 3 = 30. 4+ = 300 **וגדל ליניארית** באורך
          // ההמתנה: wait4·(w-3). זה קריטי למצב "ליגות במקביל": בלי הגדילה, המתנה
          // של 9 עולה כמו המתנה של 4, ולמתזמן אין תמריץ לדחוס. עם הגדילה, כל סלוט
          // המתנה נוסף כואב יותר, והחיפוש דוחס כל קבוצה לחלון קומפקטי (המתנה 1–2).
          if (w === 3) {
            wait += W.wait3;
            if (V) V.push({ kind:'longWait', cost:W.wait3, slot:prev, team:s.teams[t],
                            text:`${s.teams[t]} ממתינה 3 סלוטים` });
          } else if (w >= 4) {
            const c = W.wait4 * (w - 3);   // w=4→300, w=5→600, … w=9→1800
            wait += c;
            if (V) V.push({ kind:'longWait', cost:c, slot:prev, team:s.teams[t],
                            text:`${s.teams[t]} ממתינה ${w} סלוטים` });
          }
        }
      }
      prev = sl; last = sl;
    }
    if (n) {
      span += W.span * (last - first);
      if (n > hi[t]) {
        const c = W.gamesOver * (n - hi[t]); gamesOver += c;
        if (V) V.push({ kind:'tooMany', cost:c, team:s.teams[t],
                        text:`${s.teams[t]} — ${n} משחקים ביום (המכסה ${hi[t]})` });
      }
      if (n < lo[t]) {
        const c = W.gamesUnder * (lo[t] - n); gamesUnder += c;
        if (V) V.push({ kind:'tooFew', cost:c, team:s.teams[t],
                        text:`${s.teams[t]} — ${n} משחקים בלבד ביום (המינימום ${lo[t]})` });
      }
      // הוגנות מוקדם/מאוחר (חוצה-ימים): קבוצה בסלוט הראשון (17:00) או בסלוט
      // האחרון של היום, שכבר קיבלה סלוט קיצון בימים קודמים.
      if (fairPrior[t] && (first === 1 || last === lastSlot)) {
        const c = W.fairness * fairPrior[t]; fairness += c;
        if (V) V.push({ kind:'fairness', cost:c, team:s.teams[t],
                        text:`${s.teams[t]} שוב בסלוט ה${first === 1 ? 'ראשון' : 'אחרון'} של היום` });
      }
      // פיזור רשתות: קבוצה על יותר מרשת אחת ביום (רצוי פחות, לא חובה).
      let bits = teamNets[t], cnt = 0; while (bits) { bits &= bits - 1; cnt++; }
      if (cnt > 1) netSpread += W.netSpread * (cnt - 1);
    } else if (lo[t] > 0) {
      const c = W.gamesUnder * lo[t]; gamesUnder += c;
      if (V) V.push({ kind:'noGames', cost:c, team:s.teams[t],
                      text:`${s.teams[t]} בלי אף משחק ביום` });
    }
  }

  // ── לפי תא: שני משחקים על אותו תא (קשיח), תא חסום (קשיח), וחור מוקדם ──
  let empties = 0;
  for (let sl = 1; sl <= S; sl++) {
    for (let k = 0; k < N; k++) {
      const idx = sl * N + k, c = cc[idx];
      if (c > 1) {
        hard += W.hard * (c - 1);
        if (V) V.push({ kind:'cellClash', cost:W.hard*(c-1), slot:sl, net:s.nets[k],
                        text:`${c} משחקים על אותו תא` });
      }
      if (c && blocked[idx]) {
        hard += W.hard * c;
        if (V) V.push({ kind:'blockedCell', cost:W.hard*c, slot:sl, net:s.nets[k],
                        text:'משחק על תא שסומן כחסום' });
      }
      if (!c && !blocked[idx] && sl <= lastSlot) {
        empties++;
        // מוקדמוּת = כמה רחוק מסוף היום. חור בסלוט האחרון = 0 (חינם); מוקדם
        // יותר יקר יותר — כך החורים נדחפים להתרכז בסוף (לליגה שלישית).
        const early = lastSlot - sl;
        if (early > 0) {
          const c2 = W.emptyEarly * early; emptyEarly += c2;
          if (V) V.push({ kind:'emptyEarly', cost:c2, slot:sl, net:s.nets[k],
                          text:`תא ריק בסלוט מוקדם (${sl})` });
        }
      }
    }
  }

  // ── סיום מאוחר: היום נגמר אחרי המינימום התאורטי (⌈משחקים/רשתות⌉). דוחף את
  //    המשחקים האמיתיים לסלוטים המוקדמים ואת החורים לסוף. 100 × מרחק. ──
  if (placed) {
    const minSlots = Math.ceil(placed / N);
    const dist = lastSlot - minSlots;
    if (dist > 0) {
      lateFinish = W.lateFinish * dist;
      if (V) V.push({ kind:'lateFinish', cost:lateFinish, slot:lastSlot,
                      text:`היום נגמר ${dist} ${dist === 1 ? 'סלוט' : 'סלוטים'} אחרי המינימום התאורטי` });
    }
  }

  // ── לפי משחק: אין שופטת (5.2/5.3 — רך), ושאו לא על הרשת המועדפת (רך) ──
  // השופטת: מופר רק אם יש משחק על אותה רשת ב-S+1 (יש את מי לשפוט) ושתי הקבוצות
  // של המשחק הנוכחי משחקות ב-S+1 (אין מי שיישאר לשפוט).
  for (let i = 0; i < s.G; i++) {
    const sl = pl.slot[i]; if (!sl) continue;
    const net = pl.net[i], np = s.netPos.get(net);
    if (gFixedNet[i] && net !== gFixedNet[i]) {
      showNet += W.showNotNet1;
      if (V) V.push({ kind:'showNotNet1', cost:W.showNotNet1, slot:sl, net, key:ctx.games[i].key,
                      text:'שאו לא על הרשת המועדפת' });
    }
    if (np != null && sl < S && cc[(sl + 1) * N + np] > 0
        && tc[gA[i] * (S + 2) + sl + 1] > 0 && tc[gB[i] * (S + 2) + sl + 1] > 0) {
      noReferee += W.noReferee;
      if (V) V.push({ kind:'noReferee', cost:W.noReferee, slot:sl, net, key:ctx.games[i].key,
                      text:'שתי הקבוצות ממשיכות לסלוט הבא — אין מי שישפוט' });
    }
  }

  // ── שתי קבוצות שחולקות שחקנית (§5.4) ──
  //    מקביל (אותו סלוט) = **קשיח**: השחקנית לא יכולה להיות בשני מקומות. לא
  //    משנה אם היא זוג או שלישייה — האילוץ הוא ברמת הקבוצה, כי הרכב המשחק
  //    נקבע רק על החוף (החלטת המשתמשת).
  //    רצף (סלוט צמוד) = **אזהרה רכה**: אפשרי, אבל 6–7 משחקים בערב זה הרבה.
  for (const [ia, ib] of s.linked) {
    for (let sl = 1; sl <= S; sl++) {
      const na = tc[ia * (S + 2) + sl];
      if (!na) continue;
      const nb = tc[ib * (S + 2) + sl];
      if (nb) {
        const c = W.hard * Math.min(na, nb);
        hard += c;
        if (V) V.push({ kind:'sharedPlayerSameSlot', cost:c, slot:sl, team:s.teams[ia],
                        other:s.teams[ib],
                        text:`${s.teams[ia]} ו-${s.teams[ib]} חולקות שחקנית ומשובצות באותו סלוט` });
      }
      const adj = (sl > 1 ? tc[ib * (S + 2) + sl - 1] : 0)
                + (sl < S ? tc[ib * (S + 2) + sl + 1] : 0);
      if (adj) {
        const c = W.linkedAdjacent * adj;
        linkedAdjacent += c;
        if (V) V.push({ kind:'sharedPlayerAdjacent', cost:c, slot:sl, team:s.teams[ia],
                        other:s.teams[ib],
                        text:`${s.teams[ia]} ו-${s.teams[ib]} חולקות שחקנית ומשחקות בסלוטים עוקבים` });
      }
    }
  }

  // ── רצף קטגוריה לא נקי על רשת: קטגוריה שחוזרת אחרי שעזבה (א׳→ב׳→א׳). מעבר
  //    בודד (א׳→ב׳) נקי וחינמי; רק חזרה נענשת. תאים ריקים אינם שוברים רצף. ──
  for (let k = 0; k < N; k++) {
    let prevCat = 0, seen = 0;
    for (let sl = 1; sl <= S; sl++) {
      const cat = cellCat[sl * N + k];
      if (!cat) continue;
      if (cat !== prevCat) {
        const bit = cat < 31 ? (1 << cat) : 0;
        if (bit && (seen & bit)) {
          catReturn += W.catReturn;
          if (V) V.push({ kind:'catReturn', cost:W.catReturn, slot:sl, net:s.nets[k],
                          text:`רשת ${s.nets[k]} חוזרת לקטגוריה שכבר עזבה` });
        }
        seen |= bit;
        prevCat = cat;
      }
    }
  }

  const breakdown = { hard, backToBack: streak, gamesOver, gamesUnder, longWait: wait,
                      catReturn, noReferee, showNotNet1: showNet, lateFinish,
                      emptyCell: emptyEarly, fairness, span, netSpread, linkedAdjacent };
  const total = hard + streak + gamesOver + gamesUnder + wait + catReturn + noReferee
              + showNet + lateFinish + emptyEarly + fairness + span + netSpread + linkedAdjacent;
  return collect
    ? { total, breakdown, violations: V, lastSlot, empties, placed, hard }
    : total;
}

// גרסה ציבורית: מקבלת גם Map(key→{slot,net}) וגם את הייצוג הפנימי.
export function dayCost(place, ctx) {
  const pl = place instanceof Map ? mapToPlacement(place, ctx) : place;
  return evalDay(pl, ctx, true);
}

function mapToPlacement(map, ctx) {
  const pl = emptyPlacement(ctx);
  ctx.games.forEach((g, i) => {
    const p = map.get(g.key);
    if (p) { pl.slot[i] = p.slot; pl.net[i] = p.net; }
  });
  return pl;
}

function placementToMap(pl, ctx) {
  const m = new Map();
  ctx.games.forEach((g, i) => { if (pl.slot[i]) m.set(g.key, { slot: pl.slot[i], net: pl.net[i] }); });
  return m;
}

// ============================================================================
// האריזה החמדנית
// ============================================================================
function greedyFill(ctx, plan, rng) {
  const S = ctx.slots;
  const pl = emptyPlacement(ctx);
  const idxOf = new Map(ctx.games.map((g, i) => [g.key, i]));

  const slotTeams = Array.from({ length: S + 2 }, () => new Set());
  const cellUsed  = new Set();
  const last = new Map();       // קבוצה → הסלוט האחרון ששובץ לה
  const remCount = new Map();   // קבוצה → כמה משחקים נותרו לה ביום
  const catInSlot = new Map();  // 'cat|slot' → כמה

  for (const g of ctx.games) {
    remCount.set(g.a, (remCount.get(g.a) || 0) + 1);
    remCount.set(g.b, (remCount.get(g.b) || 0) + 1);
  }

  const put = (g, slot, net) => {
    const i = idxOf.get(g.key);
    pl.slot[i] = slot; pl.net[i] = net;
    slotTeams[slot].add(g.a); slotTeams[slot].add(g.b);
    cellUsed.add(slot + '|' + net);
    catInSlot.set(g.cat + '|' + slot, (catInSlot.get(g.cat + '|' + slot) || 0) + 1);
    for (const t of [g.a, g.b]) {
      remCount.set(t, remCount.get(t) - 1);
      if (!last.has(t) || last.get(t) < slot) last.set(t, slot);
    }
  };

  // הנעולים תופסים את מקומם לפני הכול (§6.3)
  for (const g of ctx.games) if (g.locked && g.slot && g.net) put(g, g.slot, g.net);

  const pool = {};
  for (const cat of ctx.cats)
    pool[cat.id] = ctx.games.filter(g => g.cat === cat.id && !pl.slot[idxOf.get(g.key)]);

  const inWindow = (t, s) => { const w = ctx.avail[t]; return !w || (s >= w.from && s <= w.to); };
  const freeNets = s => ctx.netIds.filter(n => !ctx.blocked.has(s + '|' + n) && !cellUsed.has(s + '|' + n));

  // §5.4 — קבוצות שחולקות שחקנית לא יכולות להיות באותו סלוט (קשיח). האריזה
  // מכבדת את זה **מראש** ולא משאירה את זה לפאס התיקון: משחק שנארז על שותפה
  // הוא הפרה קשיחה, ופאס התיקון מתקן הפרה אחת בכל פעם ובתוך רדיוס — כלומר
  // הוא לא מובטח לנקות אותן. מונע במקום לתקן.
  const partnerIds = new Map();
  const linkPair = (a, b) => {
    if (!partnerIds.has(a)) partnerIds.set(a, new Set());
    partnerIds.get(a).add(b);
  };
  for (const [a, b] of ctx.linked || []) { if (a !== b) { linkPair(a, b); linkPair(b, a); } }
  const partnersOf = t => partnerIds.get(t);
  // האם לקבוצה t יש שותפה בתוך קבוצת-קבוצות נתונה (סלוט תפוס, או בחירה חלקית)
  const linkBusy = (t, set) => {
    const ps = partnersOf(t);
    if (!ps) return false;
    for (const p of ps) if (set.has(p)) return true;
    return false;
  };

  const ordered = catOrder(ctx);
  const deficit = {};
  for (const cat of ordered) deficit[cat.id] = 0;

  for (let s = 1; s <= S; s++) {
    for (const cat of ordered) {
      const list = pool[cat.id];
      if (!list.length) continue;

      const pairCap = Math.max(1, Math.floor((cat.teams?.length || 0) / 2));
      const prevN = catInSlot.get(cat.id + '|' + (s - 1)) || 0;
      const nowN  = catInSlot.get(cat.id + '|' + s) || 0;

      // התוכנית היא יעד ולא תקרה: ליגה שפיגרה בסלוט קודם (כי לא נמצא משחק
      // כשיר) מקבלת את החוב בחזרה כאן, כפוף לאותם שני אילוצים.
      let want = Math.min(
        (plan[cat.id]?.[s - 1] || 0) + deficit[cat.id] - nowN,
        pairCap - prevN - nowN
      );

      // §6.2: הרשת המועדפת (שאו→1) בראש, אבל שאר הרשתות זמינות כשהיא תפוסה.
      const nets = orderNets(freeNets(s), cat.fixedNet);
      const chosen = pickSlotGames(list, s, Math.min(want, nets.length));
      chosen.forEach((g, i) => { put(g, s, nets[i]); list.splice(list.indexOf(g), 1); });

      deficit[cat.id] = Math.max(0,
        deficit[cat.id] + (plan[cat.id]?.[s - 1] || 0) - (chosen.length + nowN));
    }
  }

  const leftovers = ctx.cats.flatMap(cat => pool[cat.id]);
  return { pl, leftovers };

  // כשירות של משחק לסלוט s. שני המסננים הראשונים קשיחים (§6.2); השלישי —
  // אי־רצף — הוא מה שמייצר את הקצב 4-3-4-3, ראו הערת planSlotCounts.
  function eligible(g, s) {
    if (slotTeams[s].has(g.a) || slotTeams[s].has(g.b)) return false;
    // §5.4 — שותפה (קבוצה שחולקת שחקנית) כבר משחקת בסלוט הזה: קשיח
    if (linkBusy(g.a, slotTeams[s]) || linkBusy(g.b, slotTeams[s])) return false;
    if (!inWindow(g.a, s) || !inWindow(g.b, s)) return false;
    if (slotTeams[s - 1]?.has(g.a) || slotTeams[s - 1]?.has(g.b)) return false;
    if (slotTeams[s + 1]?.has(g.a) || slotTeams[s + 1]?.has(g.b)) return false;  // נעולים שקדימה
    return true;
  }

  // ── בחירת המשחקים לסלוט: חיפוש עם נסיגה, ולא בחירה אחת-אחת ──
  //
  // בחירה חמדנית אחת-אחת נכשלת בדיוק במקרה הצפוף: כשסלוט s-1 תפס 8 קבוצות
  // ונשארו 8, צריך **צימוד מושלם** בין השמונה שנותרו. חמדן שבוחר את המשחק
  // הטוב ביותר ואז נתקע משאיר משחקים תלושים, והם נוחתים בסוף היום — שם ראינו
  // המתנות של 7 סלוטים. הנסיגה חוזרת אחורה ומוצאת את הצימוד. מוגבלת ל-800
  // צמתים כדי שהיא לא תתפוצץ, ושומרת את הקבוצה החלקית הגדולה ביותר שנמצאה.
  function pickSlotGames(list, s, want) {
    if (want <= 0) return [];
    const elig = list.filter(g => eligible(g, s));
    if (!elig.length) return [];

    // עדיפות לקבוצות שנשארו להן הרבה משחקים (הן הקשות לשיבוץ בהמשך), ואז
    // לקבוצות שכבר ממתינות — כדי לסגור פערים לפני שהם גדלים.
    const score = g => {
      const rem = (remCount.get(g.a) || 0) + (remCount.get(g.b) || 0);
      const wA = last.has(g.a) ? s - last.get(g.a) - 1 : 1;
      const wB = last.has(g.b) ? s - last.get(g.b) - 1 : 1;
      return rem * 10 + (wA + wB) * 4 + rng() * 3;
    };
    const scored = elig.map(g => ({ g, v: score(g) })).sort((x, y) => y.v - x.v).map(x => x.g);

    const used = new Set();
    let best = [], cur = [], nodes = 0;
    const rec = start => {
      if (cur.length > best.length) best = cur.slice();
      if (cur.length === want) return true;
      if (++nodes > 800) return false;
      for (let i = start; i < scored.length; i++) {
        const g = scored[i];
        if (used.has(g.a) || used.has(g.b)) continue;
        // §5.4: eligible() בדק מול הסלוט **כפי שהיה**; כאן בודקים גם מול הבחירה
        // החלקית של אותה קריאה, אחרת שתי קבוצות שחולקות שחקנית היו יכולות
        // להיבחר יחד לאותו סלוט בתוך אותו batch.
        if (linkBusy(g.a, used) || linkBusy(g.b, used)) continue;
        used.add(g.a); used.add(g.b); cur.push(g);
        if (rec(i + 1)) return true;
        cur.pop(); used.delete(g.a); used.delete(g.b);
        if (nodes > 800) return false;
      }
      return false;
    };
    rec(0);
    return best;
  }
}

// ── שאריות: מה שלא נכנס בקצב ──
// כל שארית מקבלת את **התא הזול ביותר** שנשאר, ולא את הראשון החוקי. עם התא
// הראשון החוקי שארית אחת נוחתת בסלוט 13 ויוצרת המתנה של שבעה סלוטים; כאן היא
// משלמת 1000 על רצף בתוך החלון שלה, וזה עדיין זול יותר. משחק שאין לו שום תא
// חוקי מדווח ולא נעלם בשקט (§6.3).
function placeLeftovers(ctx, pl, leftovers) {
  const s = scratch(ctx);
  const idxOf = new Map(ctx.games.map((g, i) => [g.key, i]));
  const unplaced = [];

  for (const g of leftovers) {
    const i = idxOf.get(g.key);
    // §6.2: אין יותר רשת קשיחה — כל רשת פנויה מותרת, וההעדפה הרכה (showNotNet1)
    // כבר משוקללת ב-evalDay, כך שהתא הזול ביותר יעדיף ממילא את הרשת המועדפת.
    let bestCost = Infinity, bestSlot = 0, bestNet = 0;

    const taken = new Set();
    for (let j = 0; j < s.G; j++) if (pl.slot[j]) taken.add(pl.slot[j] + '|' + pl.net[j]);

    for (let sl = 1; sl <= ctx.slots; sl++) {
      for (const net of ctx.netIds) {
        if (taken.has(sl + '|' + net) || ctx.blocked.has(sl + '|' + net)) continue;
        pl.slot[i] = sl; pl.net[i] = net;
        const c = evalDay(pl, ctx, false);
        if (c < bestCost) { bestCost = c; bestSlot = sl; bestNet = net; }
      }
    }
    pl.slot[i] = bestSlot; pl.net[i] = bestNet;
    if (!bestSlot) unplaced.push(g);
  }
  return unplaced;
}

// ============================================================================
// פאס התיקון — חיפוש מקומי (§6.1.ג.3)
// ============================================================================
//
// שני מהלכים: העברת משחק לתא פנוי, והחלפה בין שני משחקים. first-improvement —
// המהלך המשפר הראשון מתקבל והסריקה מתחילה מחדש. משחקים נעולים לא זזים.
//
// המהלכים מוגבלים לרדיוס סלוטים סביב המשחק. זה לא קיצור דרך: ההפרות שהחיפוש
// אמור לתקן (רצף, המתנה, שופטת) הן כולן מקומיות בזמן, והחלפה עם משחק שנמצא
// שמונה סלוטים משם כמעט תמיד רק מזיזה את הבעיה. בלי ההגבלה כל פאס עלה פי 5.
// הרדיוס נמדד: ב-4 נשארו שני רצפים במחזור שלם ובחלון של 15/15/6 (המתנה
// מקסימלית 7 סלוטים), כי משחק תלוש היה רחוק מדי מהמקום שאליו הוא שייך.
// ב-8 זה יורד ל-**אפס רצפים** ולהמתנה מקסימלית של 5, בתוספת של ~250ms.
// מעבר ל-8 העלות הכוללת כמעט לא משתנה והזנב דווקא מחמיר.
function repair(ctx, pl, opts = {}) {
  const s = scratch(ctx);
  // מצב "ליגות במקביל": יותר מהלכי-תיקון נדרשים לדחיסת החלונות (המתנה ≤3). 1500
  // מספיקים להתכנסות מלאה של המקרה האמיתי; הלולאה נשברת ממילא כשאין שיפור.
  const maxMoves = opts.maxMoves ?? 1500;
  const radius   = opts.radius ?? 12;
  // תקציב זמן קשיח לכל יום — קאפ-ביטחון לקונפיגורציה פתולוגית (5 רשתות/13 סלוטים,
  // שם החיפוש מצא אינסוף שיפורי-מיקרו ונמדד 88ש). 8ש נדיב: התיקון של המקרה האמיתי
  // מתכנס תוך <1ש הרבה לפני הקאפ, כך שהתוצאה דטרמיניסטית ואינה תלויה במהירות.
  const maxMillis = opts.maxMillis ?? 8000;
  const t0 = Date.now();
  const S = ctx.slots, N = s.N;

  let cur = evalDay(pl, ctx, false);
  const occ = new Int32Array((S + 2) * N);   // 0 = פנוי, אחרת אינדקס המשחק + 1
  let moves = 0;

  for (; moves < maxMoves; moves++) {
    if ((moves & 7) === 0 && Date.now() - t0 > maxMillis) break;
    occ.fill(0);
    for (let i = 0; i < s.G; i++) if (pl.slot[i]) occ[pl.slot[i] * N + s.netPos.get(pl.net[i])] = i + 1;

    const cands = candidates(ctx, pl, s, occ);
    let improved = false;

    for (const i of cands) {
      const s0 = pl.slot[i], n0 = pl.net[i];
      if (!s0) continue;

      const from = Math.max(1, s0 - radius), to = Math.min(S, s0 + radius);
      for (let sl = from; sl <= to && !improved; sl++) {
        for (let k = 0; k < N && !improved; k++) {
          const j = occ[sl * N + k];
          const net = s.nets[k];
          if (sl === s0 && net === n0) continue;

          if (!j) {                                   // (א) העברה לתא פנוי
            if (s.blocked[sl * N + k]) continue;
            pl.slot[i] = sl; pl.net[i] = net;
            const c = evalDay(pl, ctx, false);
            if (c < cur) { cur = c; improved = true; break; }
            pl.slot[i] = s0; pl.net[i] = n0;
          } else {                                    // (ב) החלפה
            const j0 = j - 1;
            if (j0 === i || s.gLocked[j0]) continue;
            pl.slot[i] = sl; pl.net[i] = net;
            pl.slot[j0] = s0; pl.net[j0] = n0;
            const c = evalDay(pl, ctx, false);
            if (c < cur) { cur = c; improved = true; break; }
            pl.slot[i] = s0; pl.net[i] = n0;
            pl.slot[j0] = sl; pl.net[j0] = net;
          }
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  return { pl, cost: cur, moves };
}

// המשחקים שנוגעים בהפרה כלשהי, ועוד המשחקים בסלוט האחרון — להזיז אותם קדימה
// מקצר את היום. סריקת כל המשחקים בכל איטרציה הייתה מיותרת ברובה.
function candidates(ctx, pl, s, occ) {
  const { T, S, N, tc, cc, blocked, availFrom, availTo, lo, hi, gA, gB, gFixedNet } = s;
  const out = new Set();
  const addTeam = t => { for (const i of s.teamGames[t]) if (!s.gLocked[i] && pl.slot[i]) out.add(i); };

  let lastSlot = 0;
  for (let i = 0; i < s.G; i++) if (pl.slot[i] > lastSlot) lastSlot = pl.slot[i];

  for (let t = 0; t < T; t++) {
    const base = t * (S + 2);
    let prev = 0, n = 0, bad = false;
    for (let sl = 1; sl <= S; sl++) {
      const c = tc[base + sl]; if (!c) continue;
      if (c > 1 || sl < availFrom[t] || sl > availTo[t]) bad = true;
      // מועמד להזזה: רצף (gap=1) או המתנה נענשת (gap≥4 = 3+ סלוטים; 1–2 חינם).
      if (prev && (sl - prev === 1 || sl - prev > 3)) bad = true;
      prev = sl; n += c;
    }
    if (bad || n > hi[t] || n < lo[t]) addTeam(t);
  }

  // §5.4 — זוג קבוצות שחולקות שחקנית ומשובצות באותו סלוט (קשיח) או בסלוטים
  // עוקבים (רך): שני הצדדים מועמדים להזזה. בלי זה פאס התיקון לא "רואה" את
  // ההפרה אלא במקרה, כי אף אחד מהמסננים האחרים לא נוגע בה.
  for (const [ia, ib] of s.linked) {
    let bad = false;
    for (let sl = 1; sl <= S && !bad; sl++) {
      if (!tc[ia * (S + 2) + sl]) continue;
      if (tc[ib * (S + 2) + sl]
          || (sl > 1 && tc[ib * (S + 2) + sl - 1])
          || (sl < S && tc[ib * (S + 2) + sl + 1])) bad = true;
    }
    if (bad) { addTeam(ia); addTeam(ib); }
  }

  for (let i = 0; i < s.G; i++) {
    const sl = pl.slot[i]; if (!sl || s.gLocked[i]) continue;
    const np = s.netPos.get(pl.net[i]);
    if (np == null) { out.add(i); continue; }
    if (cc[sl * N + np] > 1 || blocked[sl * N + np]) out.add(i);
    if (gFixedNet[i] && pl.net[i] !== gFixedNet[i]) out.add(i);
    if (sl < S && cc[(sl + 1) * N + np] > 0
        && tc[gA[i] * (S + 2) + sl + 1] > 0 && tc[gB[i] * (S + 2) + sl + 1] > 0) out.add(i);
    if (sl === lastSlot) out.add(i);
  }

  // קפיצות-ליגה בתוך רשת: מחושב מ-occ (המצב הנוכחי) ולא מ-cellCat (שעלול להיות
  // בתוקף של מהלך שנדחה). כשתא שייך לליגה שונה מהתא התפוס הקודם באותה רשת —
  // שני המשחקים מועמדים להזזה כדי לאחד את הבלוקים.
  for (let k = 0; k < N; k++) {
    let prevGame = -1, prevCat = 0;
    for (let sl = 1; sl <= S; sl++) {
      const g = occ[sl * N + k]; if (!g) continue;
      const i = g - 1, cat = s.gCat[i];
      if (prevCat && cat !== prevCat) {
        if (!s.gLocked[i]) out.add(i);
        if (prevGame >= 0 && !s.gLocked[prevGame]) out.add(prevGame);
      }
      prevGame = i; prevCat = cat;
    }
  }

  return [...out];
}

// ── פאס "רוקן את הסלוט האחרון" — לסיום מוקדם (המטרה העליונה, החלטת המשתמשת 25.7) ──
// דוחס את היום מ-16 ל-15 סלוטים = 22:00 (המינימום המתמטי: 60 משחקים על 4 רשתות).
// לא ניתן להשיג זאת צעד-צעד: הזזת משחק בודד מהסלוט האחרון לא מקצרת את היום עד
// שכולם זזים, ולכן כל צעד ביניים "נראה גרוע" והחיפוש המקומי נתקע. כאן מטפלים בכל
// הסלוט האחרון **יחד**: אם אפשר לשבץ את כל משחקיו לתאים ריקים מוקדמים יותר בלי
// אילוץ קשיח **ובלי רצף שאו/א׳** (שיבוץ מושלם, חיפוש עם נסיגה) — עושים זאת והיום
// מתקצר. חוזרים עד שאי אפשר עוד; טבעית עוצר ב-15 סלוטים (אין אז חורים לספיגה).
// togetherness מותר לרדת — זו המטרה השנייה. זוגות ליגה ב׳ מותרים.
function emptyLastSlot(ctx, pl) {
  const s = scratch(ctx);
  const S = ctx.slots, N = s.N;
  let placed = 0; for (let i = 0; i < s.G; i++) if (pl.slot[i]) placed++;
  const minSlots = Math.ceil(placed / N);

  const playsAt = (t, sl, except) => {
    if (sl < 1 || sl > S) return false;
    for (const j of s.teamGames[t]) if (j !== except && pl.slot[j] === sl) return true;
    return false;
  };
  // §5.4 — האם שותפה כלשהי של t (קבוצה שחולקת איתה שחקנית) משחקת בסלוט sl
  const linkPlaysAt = (t, sl, except) => {
    for (const p of s.partners[t]) if (playsAt(p, sl, except)) return true;
    return false;
  };
  // כמה הפרות "שותפות באותו סלוט" יש בלוז — לאימות אחרי אצווה (קשיח)
  const countLinkSame = () => {
    let n = 0;
    for (const [ia, ib] of s.linked)
      for (const j of s.teamGames[ia])
        if (pl.slot[j] && playsAt(ib, pl.slot[j], -1)) n++;
    return n;
  };
  // רצפי שאו/א׳ בכל הלוז — לאימות שהאצווה לא יצרה חדשים (לוק קשיח)
  const countSL1 = () => {
    let n = 0;
    for (let t = 0; t < s.T; t++) {
      if (s.allowConsec[t]) continue;
      const sl = [];
      for (const j of s.teamGames[t]) if (pl.slot[j]) sl.push(pl.slot[j]);
      sl.sort((a, b) => a - b);
      for (let i = 1; i < sl.length; i++) if (sl[i] - sl[i - 1] === 1) n++;
    }
    return n;
  };
  const baseSL1 = countSL1();
  const baseLink = countLinkSame();

  for (let guard = 0; guard < S; guard++) {
    let lastSlot = 0;
    for (let i = 0; i < s.G; i++) if (pl.slot[i] > lastSlot) lastSlot = pl.slot[i];
    if (lastSlot <= minSlots) break;

    const lastGames = []; let locked = false;
    for (let i = 0; i < s.G; i++) if (pl.slot[i] === lastSlot) { if (s.gLocked[i]) locked = true; lastGames.push(i); }
    if (locked || !lastGames.length) break;

    const occ = new Uint8Array((S + 2) * N);
    for (let i = 0; i < s.G; i++) if (pl.slot[i]) occ[pl.slot[i] * N + s.netPos.get(pl.net[i])] = 1;
    const holes = [];
    for (let sl = 1; sl < lastSlot; sl++) for (let k = 0; k < N; k++)
      if (!occ[sl * N + k] && !s.blocked[sl * N + k]) holes.push({ sl, net: s.nets[k] });
    if (holes.length < lastGames.length) break;

    // תאים חוקיים לכל משחק: רשת קבועה, חלון זמינות, שתי הקבוצות פנויות בסלוט,
    // ובלי ליצור רצף שאו/א׳ (קבוצת שאו/א׳ שכבר משחקת בסלוט צמוד).
    const legal = lastGames.map(i => {
      const a = s.gA[i], b = s.gB[i], fx = s.gFixedNet[i], out = [];
      for (let hi = 0; hi < holes.length; hi++) {
        const { sl, net } = holes[hi];
        if (fx && net !== fx) continue;
        if (sl < s.availFrom[a] || sl > s.availTo[a] || sl < s.availFrom[b] || sl > s.availTo[b]) continue;
        if (playsAt(a, sl, i) || playsAt(b, sl, i)) continue;
        // §5.4 — שותפה משחקת בסלוט הזה: קשיח, גם כשהמטרה היא לקצר את היום
        if (linkPlaysAt(a, sl, i) || linkPlaysAt(b, sl, i)) continue;
        if (!s.allowConsec[a] && (playsAt(a, sl - 1, i) || playsAt(a, sl + 1, i))) continue;
        if (!s.allowConsec[b] && (playsAt(b, sl - 1, i) || playsAt(b, sl + 1, i))) continue;
        out.push(hi);
      }
      return out;
    });

    // שיבוץ מושלם: תא נפרד לכל משחק (חיפוש עם נסיגה). המשחקים הקשים (מעט תאים)
    // ראשונים כדי לגזום מוקדם.
    const order = lastGames.map((_, x) => x).sort((p, q) => legal[p].length - legal[q].length);
    const usedHole = new Int8Array(holes.length), chosen = new Array(lastGames.length).fill(-1);
    // §5.4 — לאן הלכה כל קבוצה **בתוך האצווה הזאת** (0 = לא הוזזה). `legal`
    // נבדק מול הלוז כפי שהוא לפני האצווה, ולכן שתי שותפות שנמצאות שתיהן בסלוט
    // האחרון היו יכולות לנחות יחד באותו סלוט מוקדם. כל קבוצה מופיעה לכל היותר
    // במשחק אחד באצווה (כולן באותו סלוט), ולכן ערך יחיד לכל קבוצה מספיק.
    const batchSlot = new Int32Array(s.T);
    const linkFreeInBatch = (t, sl) => {
      for (const p of s.partners[t]) if (batchSlot[p] === sl) return false;
      return true;
    };
    let nodes = 0;
    const rec = oi => {
      if (oi === order.length) return true;
      if (++nodes > 5000) return false;
      const x = order[oi], i = lastGames[x], a = s.gA[i], b = s.gB[i];
      for (const hi of legal[x]) {
        if (usedHole[hi]) continue;
        const sl = holes[hi].sl;
        if (!linkFreeInBatch(a, sl) || !linkFreeInBatch(b, sl)) continue;
        usedHole[hi] = 1; chosen[x] = hi;
        batchSlot[a] = sl; batchSlot[b] = sl;
        if (rec(oi + 1)) return true;
        usedHole[hi] = 0; chosen[x] = -1;
        batchSlot[a] = 0; batchSlot[b] = 0;
      }
      return false;
    };
    if (!rec(0)) break;

    // החלה, עם גיבוי לביטול אם האימות נכשל
    const backup = lastGames.map(i => [i, pl.slot[i], pl.net[i]]);
    for (let x = 0; x < lastGames.length; x++) { const i = lastGames[x], h = holes[chosen[x]]; pl.slot[i] = h.sl; pl.net[i] = h.net; }
    if (countSL1() > baseSL1 || countLinkSame() > baseLink) {
      for (const [i, sl, nt] of backup) { pl.slot[i] = sl; pl.net[i] = nt; }
      break;
    }
  }
  return pl;
}

// ── פאס דחיסת חורים סופי (תיקון באג 25.7) ──
// פאס התיקון מוגבל ברדיוס וברשימת מועמדים, ולכן החמיץ מהלכים שמושכים משחק מאוחר
// אל תא ריק מוקדם — נשארו "חורים באמצע" שאפשר היה למלא. כאן סורקים כל תא ריק
// מהמוקדם למאוחר, ומושכים אליו את המשחק **המאוחר ביותר** שאפשר בלי להעלות את
// העלות הכוללת. מכיוון שהעלות כוללת רצף (≥1000), המתנה (מדורגת) וסיום, התנאי
// c ≤ cur מבטיח שאף לוק לא נשבר — לא נוצר רצף שאו/א׳, המתנה לא גדלה והיום לא
// מתארך — והחור פשוט נדחף לזנב. כל מהלך מזיז חור לסלוט מאוחר יותר, ולכן מתכנס.
function compactHoles(ctx, pl) {
  const s = scratch(ctx);
  const S = ctx.slots, N = s.N;
  let cur = evalDay(pl, ctx, false);
  const occ = new Int32Array((S + 2) * N);

  for (let guard = 0; guard < 1000; guard++) {
    let lastSlot = 0;
    for (let i = 0; i < s.G; i++) if (pl.slot[i] > lastSlot) lastSlot = pl.slot[i];
    occ.fill(0);
    for (let i = 0; i < s.G; i++) if (pl.slot[i]) occ[pl.slot[i] * N + s.netPos.get(pl.net[i])] = i + 1;

    let did = false;
    for (let sl = 1; sl < lastSlot && !did; sl++) {
      for (let k = 0; k < N && !did; k++) {
        if (occ[sl * N + k] || s.blocked[sl * N + k]) continue;   // תפוס או חסום
        const net = s.nets[k];
        // המשחק המאוחר ביותר שאפשר למשוך לכאן בלי להעלות עלות
        let bestJ = -1, bestSrc = sl;
        for (let j = 0; j < s.G; j++) {
          const js = pl.slot[j];
          if (js <= bestSrc || s.gLocked[j]) continue;            // רק משחק מאוחר מהחור, והמאוחר ביותר
          const os = js, on = pl.net[j];
          pl.slot[j] = sl; pl.net[j] = net;
          const c = evalDay(pl, ctx, false);
          pl.slot[j] = os; pl.net[j] = on;
          if (c <= cur) { bestJ = j; bestSrc = js; }
        }
        if (bestJ >= 0) {
          pl.slot[bestJ] = sl; pl.net[bestJ] = net;
          cur = evalDay(pl, ctx, false);
          did = true;
        }
      }
    }
    if (!did) break;
  }
  return pl;
}

// ── האריזה המלאה ליום אחד ──
// כמה הרצות עם זרעים שונים, והטובה מנצחת. הזרעים קבועים, ולכן שתי הרצות של
// אותו קלט נותנות אותו לוז בדיוק.
export function packDay(ctx, opts = {}) {
  // מצב "ליגות במקביל" דורש יותר חיפוש: לדחוס כל קבוצה לחלון קומפקטי (המתנה
  // ≤3) בזמן ששתי הליגות רצות במקביל הוא בעיה קשה יותר מהסידור הרציף הישן, ו-3–4
  // הרצות (מה שהתקציב הישן של 2.2ש הרשה בפועל) הותירו מדי פעם המתנה של 5–6.
  // 16 הרצות מביאות למקס׳ המתנה 4 באופן יציב. המשתמשת ביקשה מפורשות שהמהירות
  // לא משנה — לכן החיפוש מלא. נמדד: ~8ש ליום, ~32ש לעונה.
  // 32 הרצות (25.7): המטרה העליונה היא סיום מוקדם. נמדד שב-16 הרצות רק 3/4 הימים
  // נדחסים ל-15 סלוטים (22:00); ב-32 — **כל 4 הימים** מגיעים ל-22:00 עם 0 חורים
  // (48 נותן זהה → 32 יציב, לא מקרי). דטרמיניסטי (זרעים קבועים). ~70ש/עונה.
  const restarts = opts.restarts ?? 32;
  // תקציב זמן ליום נדיב (60ש) — קאפ-ביטחון לקונפיגורציה פתולוגית בלבד. במקרה
  // האמיתי (4 רשתות, 16 סלוטים) 16 ההרצות מסתיימות תוך ~8ש הרבה לפני הקאפ, כך
  // שהתוצאה **דטרמיניסטית** (כל ההרצות תמיד רצות) ואינה תלויה במהירות המכונה —
  // בניגוד לתקציב הישן שקטע ל-~4 הרצות ויצר לוז שונה בכל מכונה.
  const dayBudgetMs = opts.dayBudgetMs ?? 60000;
  const t0 = Date.now();
  const { plan, overflow } = planSlotCounts(ctx, opts);
  let best = null;

  for (let i = 0; i < restarts; i++) {
    const g = greedyFill(ctx, plan, mulberry32(0x5EED + i * 7919));
    const unplaced = placeLeftovers(ctx, g.pl, g.leftovers);
    const r = repair(ctx, g.pl, opts);
    emptyLastSlot(ctx, r.pl);                 // דחיסה לסיום מוקדם (המטרה העליונה)
    const score = evalDay(r.pl, ctx, false) + unplaced.length * WEIGHTS.hard;
    if (!best || score < best.score)
      best = { score, pl: r.pl, unplaced, moves: r.moves, seed: i };
    if (i >= 2 && Date.now() - t0 > dayBudgetMs) break;
  }

  // דחיסת חורים לזנב (תיקון באג 25.7): פאס אחרון על הלוז הנבחר בלבד — מבטיח
  // שאין תא ריק שאפשר למלא במשחק מאוחר בלי להעלות עלות (ולכן בלי לשבור לוק).
  // רץ פעם אחת (לא לכל הרצה) — זול, ודטרמיניסטי. במקרה המקבילי הוא בד"כ no-op
  // כי האריזה כבר מרכזת חורים בזנב, אבל הוא רשת-ביטחון לרוסטרים אחרים.
  compactHoles(ctx, best.pl);

  const cost = evalDay(best.pl, ctx, true);
  const place = placementToMap(best.pl, ctx);
  return { place, pl: best.pl, cost, unplaced: best.unplaced, moves: best.moves,
           seed: best.seed, plan, overflow, windows: windowsOf(ctx, best.pl) };
}

// חלון ההגעה בפועל לכל ליגה — הסלוט הראשון והאחרון שבו היא משחקת. זה מה
// שאומר לשחקניות מתי להגיע (§4.3), והוא תוצאה של האריזה ולא קלט לה.
function windowsOf(ctx, pl) {
  const out = {};
  for (const cat of ctx.cats) {
    let lo = Infinity, hi = 0, n = 0;
    ctx.games.forEach((g, i) => {
      if (g.cat !== cat.id || !pl.slot[i]) return;
      n++;
      if (pl.slot[i] < lo) lo = pl.slot[i];
      if (pl.slot[i] > hi) hi = pl.slot[i];
    });
    out[cat.id] = n ? { from: lo, to: hi, games: n } : null;
  }
  return out;
}

// ============================================================================
// מונה אורך היום — §4.6
// ============================================================================
//
// שני מספרים שונים, ולא לבלבל ביניהם:
//   endSlot / endTime — הסיום **בפועל** של הסידור הנוכחי
//   projection        — הרצפה התאורטית אם יישמרו עוד K תאים לליגה שלישית.
//                       זהו חסם תחתון בלבד (⌈תאים/רשתות⌉), כי אין לדעת מראש
//                       איפה המנהלת תניח את התאים. ל-64 תאים ו-60 משחקים היא
//                       מחזירה בדיוק את §4.6: 0–4 → 22:20 · 8 → 22:40 · 12 → 23:00.
export function dayLength(place, ctx, extras = [0, 4, 8, 12]) {
  const pl = place instanceof Map ? mapToPlacement(place, ctx) : place;
  let endSlot = 0, used = 0;
  for (let i = 0; i < ctx.games.length; i++) {
    if (!pl.slot[i]) continue;
    used++;
    if (pl.slot[i] > endSlot) endSlot = pl.slot[i];
  }
  for (const k of ctx.blocked) {
    const s = +k.split('|')[0];
    if (s > endSlot) endSlot = s;
  }

  const nets = ctx.netIds.length || 1;
  const capacity = ctx.slots * nets;
  const blocks = ctx.blocked.size;

  return {
    endSlot,
    endTime: dayEndLabel(ctx.day, endSlot),
    used, blocks, capacity,
    freeCells: capacity - used - blocks,
    projection: extras.map(k => {
      const slots = Math.max(endSlot, Math.ceil((used + blocks + k) / nets));
      return { extra: k, slots, endTime: dayEndLabel(ctx.day, slots) };
    })
  };
}

// ============================================================================
// בניית ההקשר ליום
// ============================================================================
export function buildDayContext(input, day, dayGames, bounds) {
  const blocked = new Set();
  for (const b of input.blocks || [])
    if (b.day === day.id && b.slot && b.net) blocked.add(b.slot + '|' + b.net);

  const avail = {};
  for (const [t, av] of Object.entries(input.availability?.[day.id] || {}))
    avail[t] = availWindow(day, av);

  const cats = (input.categories || [])
    .filter(c => dayGames.some(g => g.cat === c.id))
    .map(c => ({ id: c.id, name: c.name, order: c.order, fixedNet: c.fixedNet,
                 allowConsecutive: !!c.allowConsecutive, teams: c.teams || [] }));

  const present = new Set(cats.flatMap(c => c.teams));
  for (const g of dayGames) { present.add(g.a); present.add(g.b); }

  return {
    day, dayId: day.id,
    slots: day.slots, slotMin: day.slotMin,
    netIds: [...(day.netIds || [])].sort((a, b) => a - b),
    cats, games: dayGames, blocked, avail,
    // קישורי "רשום כפול" (§6.3) — פעיל רק אם המנהלת סימנה. אין כרגע מקור נתונים
    // במודל (§5 נעול), ולכן ריק עד שיתווסף. generateSeason מזריק extremesPrior.
    linked: input.links || [],
    bounds: Object.fromEntries([...present].map(t => [t, bounds?.[t] || { lo: 0, hi: Infinity }]))
  };
}

// ============================================================================
// תזמור שלושת השלבים
// ============================================================================
//
// input:
//   categories: [{ id, name, rr, order, fixedNet, teams:[teamId] }]
//   days:       [{ id, label, startTime, slotMin, slots, netIds }]   ← ליגה סדירה בלבד
//   blocks, availability, existing
//
// opts.phases: אילו שלבים להריץ, ברירת המחדל שלושתם. §6.1 דורש ש"כל אחד יהיה
// ניתן להרצה בנפרד", ולכן כל שלב שלא נכלל **משמר את הפלט הקיים** במקום לאפס
// אותו: `['pack']` לבד אורז מחדש לפי חלוקת הימים ששמורה במסמך. זה גם הפרימיטיב
// של "סדר לי את היום מחדש" (§8.6), יחד עם opts.onlyDays.
export function generateSeason(input, opts = {}) {
  const phases = new Set(opts.phases || ['rr', 'days', 'pack']);
  const days = input.days || [];
  const dayIds = days.map(d => d.id);
  const existing = input.existing || [];
  const keyOf = g => g.key || gameKey(g.cat, g.a, g.b, g.leg || 0);
  const prev = new Map(existing.map(g => [keyOf(g), g]));

  const report = { ran: [...phases], categories: {}, days: {}, warnings: [], errors: [] };

  // ── שלב א׳ ──
  const catPlans = [];
  for (const c of input.categories || []) {
    const teams = (c.teams || []).slice();

    if (phases.has('rr')) {
      if (teams.length < 2) {
        if (teams.length) report.warnings.push(`${c.name || c.id}: פחות משתי קבוצות — אין מה לשבץ.`);
        catPlans.push({ ...c, teams, rounds: [], games: [] });
        continue;
      }
      const rounds = buildRoundRobin(teams, c.rr || 1);
      catPlans.push({ ...c, teams, rounds, games: roundsToGames(c.id, rounds) });
    } else {
      // שלב א׳ לא רץ: משתמשים במשחקים ששמורים במסמך כמו שהם, כולל היום,
      // הסלוט והרשת שלהם. כך אריזה מחדש לא מגרילה RR חדש.
      catPlans.push({ ...c, teams, rounds: [], games: existing
        .filter(g => g.cat === c.id)
        .map(g => ({ key: keyOf(g), cat: g.cat, a: g.a, b: g.b,
                     round: g.round ?? 0, leg: g.leg ?? 0,
                     day: g.day ?? null, slot: g.slot ?? null, net: g.net ?? null })) });
    }

    const cp = catPlans[catPlans.length - 1];
    if (cp.games.length) report.categories[c.id] = {
      name: c.name, teams: teams.length, rounds: cp.rounds.length, games: cp.games.length,
      perTeam: (teams.length - 1) * (c.rr || 1),
      byes: cp.rounds.reduce((n, r) => n + r.byes.length, 0)
    };
  }

  const allGames = catPlans.flatMap(c => c.games);
  if (!dayIds.length) {
    report.warnings.push('אין ימי ליגה סדירה מוגדרים.');
    return finish(allGames);
  }
  if (!phases.has('days') && !phases.has('pack')) return finish(allGames);
  if (!phases.has('days')) return pack(allGames);

  // ── שלב ב׳ ──
  // חלון זמינות צר ביום מסוים → פחות משחקים לאותה קבוצה באותו יום. זהו ה-bye
  // כמנוף של §6.3, מתורגם למודל שבו מחזורי RR מפוצלים בין ימים.
  const tight = {};
  for (const d of days) {
    const t = {};
    for (const [team, av] of Object.entries(input.availability?.[d.id] || {})) {
      const w = availWindow(d, av);
      t[team] = 1 - Math.max(0, w.to - w.from + 1) / Math.max(1, d.slots);
    }
    if (Object.keys(t).length) tight[d.id] = t;
  }

  const locked = {};
  for (const g of existing)
    if (g.locked && g.day) locked[g.key || gameKey(g.cat, g.a, g.b, g.leg || 0)] = g.day;

  const split = splitIntoDays(catPlans, dayIds, { locked, tight });
  report.split = { quotas: split.quotas, dayTotal: split.dayTotal, teamDay: split.teamDay };
  report.warnings.push(...(split.warnings || []));

  // חלוקה מחדש מבטלת את השיבוץ הקודם לגריד: סלוט 7 ביום אחר הוא נתון חסר
  // משמעות. שלב ג׳ יקבע אותו מחדש; אם הוא לא רץ, המשחק נשאר בלי סלוט במכוון.
  for (const g of allGames) { g.day = split.assign[g.key] || null; g.slot = null; g.net = null; }

  return phases.has('pack') ? pack(allGames) : finish(allGames);

  // ── שלב ג׳ ──
  function pack(games) {
    // גבולות [lo,hi] לכל קבוצה — דינמיים לפי משחקיה בפועל חלקי מספר הימים
    const totalPerTeam = {};
    for (const g of games) {
      totalPerTeam[g.a] = (totalPerTeam[g.a] || 0) + 1;
      totalPerTeam[g.b] = (totalPerTeam[g.b] || 0) + 1;
    }
    const D = dayIds.length;
    const bounds = {};
    for (const [t, n] of Object.entries(totalPerTeam))
      bounds[t] = { lo: Math.floor(n / D), hi: Math.ceil(n / D) };
    report.bounds = bounds;

    const only = opts.onlyDays ? new Set(opts.onlyDays) : null;   // §8.6

    // הוגנות מוקדם/מאוחר (§6.2, חוצה-ימים): צוברים כמה ימים כבר קיבלה כל קבוצה
    // סלוט קיצון (ראשון/אחרון). הימים מעובדים לפי הסדר הכרונולוגי, כך שיום מאוחר
    // "יודע" מי כבר נדחק לקצה ומעדיף לא לחזור עליה. דטרמיניסטי (נגזר מאריזה קודמת).
    const extremesPrior = {};

    for (const day of days) {
      const dayGames = games.filter(g => g.day === day.id);
      if (!dayGames.length) { report.days[day.id] = { label: day.label, games: 0 }; continue; }
      if (only && !only.has(day.id)) continue;                    // היום הזה לא נוגעים בו

      // נעילות קיימות מוזרקות חזרה כדי שהאריזה תכבד אותן (§6.3)
      for (const g of dayGames) {
        const p = prev.get(g.key);
        if (p && p.locked && p.slot && p.net) { g.locked = true; g.slot = p.slot; g.net = p.net; }
      }

      const ctx = buildDayContext(input, day, dayGames, bounds);
      ctx.extremesPrior = extremesPrior;
      const res = packDay(ctx, opts);

      dayGames.forEach(g => {
        const p = res.place.get(g.key);
        g.slot = p ? p.slot : null;
        g.net  = p ? p.net  : null;
      });

      // עדכון מונה הקיצון לימים הבאים: מי שיחק בסלוט הראשון או בסלוט האחרון של היום
      let dayLast = 0;
      for (const g of dayGames) if (g.slot && g.slot > dayLast) dayLast = g.slot;
      const extreme = new Set();
      for (const g of dayGames)
        if (g.slot === 1 || g.slot === dayLast) { extreme.add(g.a); extreme.add(g.b); }
      for (const t of extreme) extremesPrior[t] = (extremesPrior[t] || 0) + 1;

      report.days[day.id] = {
        label: day.label, games: dayGames.length,
        cost: res.cost.total, breakdown: res.cost.breakdown,
        violations: res.cost.violations,
        unplaced: res.unplaced.map(g => g.key),
        windows: res.windows, plan: res.plan, overflow: res.overflow,
        length: dayLength(res.pl, ctx), seed: res.seed, moves: res.moves
      };
      // ⚠️ שני מצבים שונים, ולא לבלבל ביניהם:
      //   unplaced — אין תא חוקי בכלל. המשחק **לא שובץ**, וזו שגיאה.
      //   overflow — הקצב 4-3-4-3 לא הכיל את כל המשחקים בחלון שהתפנה לליגה.
      //              המשחקים כן שובצו, בתא הזול ביותר שנשאר, אבל במחיר רצף או
      //              המתנה. זו אזהרה: הגריד צר מדי ליעד של §4.4.
      if (res.unplaced.length)
        report.errors.push(`${day.label || day.id}: ${res.unplaced.length} משחקים לא שובצו — אין להם תא חוקי.`);

      // §5.4 + §6.3 ("אילוץ בלתי פתיר → לא לשבץ בשקט"): קבוצות שחולקות שחקנית.
      // מקביל = הפרה קשיחה ולכן **שגיאה** אם שרדה (המנהלת חייבת לדעת — שחקנית
      // אחת בשני מגרשים בו-זמנית); רצף = אזהרה מרוכזת, שורה אחת ליום.
      const vs = res.cost.violations || [];
      const same = vs.filter(v => v.kind === 'sharedPlayerSameSlot');
      const adj  = vs.filter(v => v.kind === 'sharedPlayerAdjacent');
      if (same.length)
        report.errors.push(`${day.label || day.id}: ${same.length} שיבוצים מקבילים של קבוצות שחולקות שחקנית ` +
          `(${[...new Set(same.map(v => `${v.team}+${v.other}`))].join(', ')}) — לא ניתן להפריד. ` +
          `הצעות: (א) העברת משחק ליום אחר (ב) הרחבת היום (ג) שיבוץ בכל זאת.`);
      if (adj.length)
        report.warnings.push(`${day.label || day.id}: ${adj.length} פעמים שקבוצות שחולקות שחקנית משחקות בסלוטים עוקבים ` +
          `— אותה שחקנית משחקת פעמיים ברצף. אפשרי, אבל שווה בדיקה.`);
      for (const [catId, n] of Object.entries(res.overflow || {})) {
        const nm = ctx.cats.find(c => c.id === catId)?.name || catId;
        report.warnings.push(
          `${day.label || day.id}: ${n} משחקים של ${nm} לא נכנסו בקצב ושובצו בפשרה. ` +
          `${day.slots} סלוטים על ${ctx.netIds.length} רשתות צרים מדי לליגה הזאת.`);
      }
    }
    return finish(games);
  }

  // המרה למבנה המשחק של §5.1, תוך שימור תוצאה, נעילה ו-id של משחקים ששרדו
  function finish(games) {
    let seq = 0;
    report.total = games.length;
    return {
      report,
      games: games.map(g => {
        const p = prev.get(g.key);
        seq++;
        return {
          id: p?.id || 'g' + String(seq).padStart(4, '0'),
          key: g.key,
          cat: g.cat, day: g.day ?? null,
          slot: g.slot ?? null, net: g.net ?? null,
          a: g.a, b: g.b, leg: g.leg, round: g.round,
          sa: p?.sa ?? null, sb: p?.sb ?? null,
          sets: p?.sets || [],
          result: p?.result || 'pending',
          locked: !!p?.locked
        };
      })
    };
  }
}
