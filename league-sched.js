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
// §6.2 — משקלי פונקציית העלות
// ============================================================================
//
// "∞" מיוצג כמספר סופי גדול, במכוון. אינסוף אמיתי היה הופך כל מצב לא־חוקי
// לשווה־ערך לכל מצב לא־חוקי אחר, והחיפוש המקומי לא היה יכול לרדת מ-3 הפרות
// ל-2. hard=1e6 גדול בסדר גודל מכל סכום רך אפשרי ולכן שומר על הסדר: כל הפרה
// קשיחה גוברת על כל צירוף של הפרות רכות.
//
// סדר העדיפויות הרך (בקשת המשתמשת): קודם כול **לעולם לא לשחק פעמיים ברצף**,
// ואז **להמתין כמה שפחות**. לכן backToBack=50000 — נמוך מ-hard אבל גבוה מכל
// קנס המתנה אפשרי, כך שהמתזמן לעולם לא "יקנה" צמצום המתנה במחיר רצף. קנס
// ההמתנה ריבועי (ראו evalDay): המתנה של סלוט אחד = אידיאל (0), ומעבר לזה
// הקנס גדל ריבועית כדי לשבור קודם את הזנבות הארוכים. span ירד ל-2 כי המשתמשת
// אמרה שלא חייבות להגיע ביחד — עדיף מקצב צמוד לכל קבוצה על פני חלון משותף קצר.
export const WEIGHTS = {
  hard:       1_000_000,   // חמשת האילוצים הקשיחים של §6.2 + רשת קבועה (החלטה 4)
  backToBack: 50_000,      // קבוצה בשני סלוטים רצופים — היעד הקשיח של החלטה 3
  gamesOver:  200,         // יותר מהמכסה העליונה ביום
  gamesUnder: 200,         // פחות מהמכסה התחתונה ביום
  longWait:   120,         // מקדם ההמתנה — מוכפל ריבועית ב-(עודף הסלוטים)²
  // מעבר בין ליגות בתוך אותה רשת (החלטת המשתמשת: בלי קפיצות). 400 עם 10 הרצות
  // (ראו packDay) נותן גם רשתות נקיות (אף רשת לא קופצת יותר מפעמיים) וגם המתנה
  // נמוכה (w3 ≈ הבסיס) — יותר הרצות מוצאות סידור טוב בשני הצירים בלי להעדיף אחד.
  netJump:    400,
  span:       2,           // טווח הנוכחות של הקבוצה ביום — נמוך במכוון
  emptyCell:  5            // תא ריק
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

  for (const cat of ordered) {
    if (!cat.games.length) continue;

    // ── מכסות: בסיס שווה, והשאריות לימים הקלים ביותר עד כה ──
    // בלי החלק השני: ליגה א׳ 27/26/26/26 + ליגה ב׳ 27/26/26/26 + שואו 8/8/7/7
    // היו נותנים 62/60/59/59 ביום. עם החלק השני זה יוצא 60/60/60/60.
    const n = cat.games.length;
    const q = Object.fromEntries(dayIds.map(d => [d, Math.floor(n / D)]));
    [...dayIds]
      .sort((x, y) => (dayTotal[x] - dayTotal[y]) || (dayIds.indexOf(x) - dayIds.indexOf(y)))
      .slice(0, n % D)
      .forEach(d => q[d]++);
    quotas[cat.id] = q;
    dayIds.forEach(d => { dayTotal[d] += q[d]; });

    // ── נעולים קודם: הם קובעים עובדה ──
    const used = zeroDays();
    const rest = [];
    for (const g of cat.games) {
      const d = locked[g.key];
      if (d && dayIds.includes(d)) { assign[g.key] = d; used[d]++; bump(g.a, d); bump(g.b, d); }
      else rest.push(g);
    }

    // ── הקצאה חמדנית, בסדר המחזורים ──
    // הקריטריון הראשי הוא כמה משחקים כבר יש לשתי הקבוצות ביום הזה. זה מה
    // שמפזר כל קבוצה על פני כל הימים במקום לרכז אותה באחד.
    for (const g of rest) {
      let best = null;
      for (const d of dayIds) {
        if (used[d] >= q[d]) continue;
        const load = (teamDay[g.a]?.[d] || 0) + (teamDay[g.b]?.[d] || 0);
        const tg   = (tight[d]?.[g.a] || 0) + (tight[d]?.[g.b] || 0);
        const score = load * 1000 + tg * 300 + used[d];
        if (!best || score < best.score) best = { d, score };
      }
      // מכסות מלאות בכל הימים לא אמור לקרות (סכום המכסות = מספר המשחקים),
      // אבל נעילות סותרות יכולות ליצור את זה. אז ליום הכי דל — ולא לאבד משחק.
      const d = best ? best.d : dayIds.reduce((x, y) => used[x] <= used[y] ? x : y);
      assign[g.key] = d; used[d]++; bump(g.a, d); bump(g.b, d);
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
export function planSlotCounts(ctx) {
  const S = ctx.slots;
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
      const allowed = cat.fixedNet
        ? (free[s - 1].has(cat.fixedNet) ? 1 : 0)
        : free[s - 1].size;
      const take = Math.max(0, Math.min(allowed, pairCap - prev - already, remaining));
      p[s - 1] = already + take;
      prev = p[s - 1];
      remaining -= take;

      if (take > 0) {
        // רק המספרים חשובים כאן; הרשת האמיתית נבחרת ב-greedyFill.
        const nets = cat.fixedNet ? [cat.fixedNet] : [...free[s - 1]];
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

  return ctx._s = {
    teams, ti, T, S, nets, N, netPos, blocked, availFrom, availTo, lo, hi,
    G, gA, gB, gFixedNet, gCat, gLocked, teamGames,
    tc:      new Int32Array(T * (S + 2)),      // קבוצה × סלוט
    cc:      new Int32Array((S + 2) * N),      // סלוט × רשת — כמה משחקים
    cellCat: new Int32Array((S + 2) * N)       // סלוט × רשת — איזו ליגה (לקוהרנטיות)
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
  const { T, S, N, tc, cc, cellCat, blocked, availFrom, availTo, lo, hi, gA, gB, gFixedNet, gCat } = s;

  tc.fill(0); cc.fill(0); cellCat.fill(0);
  let lastSlot = 0, placed = 0;

  for (let i = 0; i < s.G; i++) {
    const slot = pl.slot[i]; if (!slot) continue;
    placed++;
    if (slot > lastSlot) lastSlot = slot;
    const np = s.netPos.get(pl.net[i]);
    if (np != null) { cc[slot * N + np]++; cellCat[slot * N + np] = gCat[i]; }
    tc[gA[i] * (S + 2) + slot]++;
    tc[gB[i] * (S + 2) + slot]++;
  }

  let hard = 0, backToBack = 0, gamesOver = 0, gamesUnder = 0, longWait = 0, span = 0, netJump = 0;
  const V = collect ? [] : null;

  // ── לפי קבוצה: הקשיח "פעמיים באותו סלוט" והרך כולו, במעבר אחד ──
  for (let t = 0; t < T; t++) {
    const base = t * (S + 2);
    let prev = 0, first = 0, last = 0, n = 0;
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
          backToBack += W.backToBack;
          if (V) V.push({ kind:'backToBack', cost:W.backToBack, slot:prev, team:s.teams[t],
                          text:`${s.teams[t]} משחקת פעמיים ברצף` });
        } else if (gap - 1 > 1) {
          // המתנה של סלוט אחד (gap=2) היא האידיאל — אפס קנס. מעבר לזה הקנס
          // **ריבועי** ב"עודף" (gap-2): המתנה של 9 סלוטים כואבת פי 49 מהמתנה
          // של 2, כך שהמתזמן שובר קודם את הזנבות הארוכים ולא מפזר קנס אחיד.
          const excess = gap - 2;
          const c2 = W.longWait * excess * excess;
          longWait += c2;
          if (V) V.push({ kind:'longWait', cost:c2, slot:prev, team:s.teams[t],
                          text:`${s.teams[t]} ממתינה ${gap - 1} סלוטים` });
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
    } else if (lo[t] > 0) {
      const c = W.gamesUnder * lo[t]; gamesUnder += c;
      if (V) V.push({ kind:'noGames', cost:c, team:s.teams[t],
                      text:`${s.teams[t]} בלי אף משחק ביום` });
    }
  }

  // ── לפי תא: שני משחקים על אותו תא, תא חסום, ותא ריק ──
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
      if (!c && !blocked[idx] && sl <= lastSlot) empties++;
    }
  }

  // ── לפי משחק: אין שופטת (5.2/5.3), ורשת קבועה (החלטה 4) ──
  // האילוץ של השופטת חל רק אם באמת יש משחק על אותה רשת בסלוט הבא — אחרת אין
  // את מי לשפוט. הוא מופר כששתי הקבוצות של המשחק הנוכחי משחקות ב-S+1.
  for (let i = 0; i < s.G; i++) {
    const sl = pl.slot[i]; if (!sl) continue;
    const net = pl.net[i], np = s.netPos.get(net);
    if (gFixedNet[i] && net !== gFixedNet[i]) {
      hard += W.hard;
      if (V) V.push({ kind:'wrongNet', cost:W.hard, slot:sl, net, key:ctx.games[i].key,
                      text:'משחק של ליגה עם רשת קבועה שובץ לרשת אחרת' });
    }
    if (np != null && sl < S && cc[(sl + 1) * N + np] > 0
        && tc[gA[i] * (S + 2) + sl + 1] > 0 && tc[gB[i] * (S + 2) + sl + 1] > 0) {
      hard += W.hard;
      if (V) V.push({ kind:'noReferee', cost:W.hard, slot:sl, net, key:ctx.games[i].key,
                      text:'שתי הקבוצות ממשיכות לסלוט הבא — אין מי שישפוט' });
    }
  }

  // ── קוהרנטיות רשת (החלטת המשתמשת): כל רשת מארחת ליגה ברצף, בלי לקפוץ בין
  // ליגות מסלוט לסלוט. עוברים על כל עמודת רשת וסופרים מעבר בין ליגות שונות
  // בתאים תפוסים עוקבים. מעבר אחד (למשל שואו→ליגה, או א׳→ב׳) טבעי; הלוך-ושוב
  // הוא מה שנענש. המשקל מתחת להמתנה — קוהרנטיות לא באה על חשבון המתנה.
  for (let k = 0; k < N; k++) {
    let prevCat = 0;
    for (let sl = 1; sl <= S; sl++) {
      const cat = cellCat[sl * N + k];
      if (!cat) continue;
      if (prevCat && cat !== prevCat) {
        netJump += W.netJump;
        if (V) V.push({ kind:'netJump', cost:W.netJump, slot:sl, net:s.nets[k],
                        text:`רשת ${s.nets[k]} קופצת בין ליגות בסלוט ${sl}` });
      }
      prevCat = cat;
    }
  }

  const emptyCell = W.emptyCell * empties;
  const breakdown = { hard, backToBack, gamesOver, gamesUnder, longWait, netJump, span, emptyCell };
  const total = hard + backToBack + gamesOver + gamesUnder + longWait + netJump + span + emptyCell;
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

      const nets = cat.fixedNet
        ? (freeNets(s).includes(cat.fixedNet) ? [cat.fixedNet] : [])
        : freeNets(s);
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
    const fixed = s.gFixedNet[i];
    let bestCost = Infinity, bestSlot = 0, bestNet = 0;

    const taken = new Set();
    for (let j = 0; j < s.G; j++) if (pl.slot[j]) taken.add(pl.slot[j] + '|' + pl.net[j]);

    for (let sl = 1; sl <= ctx.slots; sl++) {
      for (const net of ctx.netIds) {
        if (fixed && net !== fixed) continue;
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
  const maxMoves = opts.maxMoves ?? 400;
  const radius   = opts.radius ?? 12;
  // תקציב זמן קשיח לכל יום. הרוב המכריע של הימים מתכנס הרבה לפני זה (הלולאה
  // נשברת כשאין שיפור); התקציב קיים כדי שקונפיגורציה פתולוגית — למשל 5 רשתות
  // על 13 סלוטים עם גלישה, שבה החיפוש מוצא אינסוף שיפורי-מיקרו — לא תקפיא את
  // הדפדפן. בלי זה נמדד מקרה של 88 שניות.
  const maxMillis = opts.maxMillis ?? 400;
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
      if (prev && (sl - prev === 1 || sl - prev > 2)) bad = true;
      prev = sl; n += c;
    }
    if (bad || n > hi[t] || n < lo[t]) addTeam(t);
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

// ── האריזה המלאה ליום אחד ──
// כמה הרצות עם זרעים שונים, והטובה מנצחת. הזרעים קבועים, ולכן שתי הרצות של
// אותו קלט נותנות אותו לוז בדיוק.
export function packDay(ctx, opts = {}) {
  const restarts = opts.restarts ?? 10;
  // תקציב זמן ליום: 10 הרצות משפרות את המקרה האמיתי (15/15/6, ~6.5ש לעונה)
  // אבל תופחות במקרים כבדים (3 מחזורים, 16 קבוצות, 5 רשתות) ל-13ש. התקציב
  // עוצר הרצות נוספות אחרי ~2.2ש ליום ברגע שיש לפחות 3 — כך היום הכבד נחסם
  // ל-~8ש לעונה, והמקרה האמיתי עדיין מספיק להריץ את כל ה-10.
  const dayBudgetMs = opts.dayBudgetMs ?? 2200;
  const t0 = Date.now();
  const { plan, overflow } = planSlotCounts(ctx);
  let best = null;

  for (let i = 0; i < restarts; i++) {
    const g = greedyFill(ctx, plan, mulberry32(0x5EED + i * 7919));
    const unplaced = placeLeftovers(ctx, g.pl, g.leftovers);
    const r = repair(ctx, g.pl, opts);
    const score = r.cost + unplaced.length * WEIGHTS.hard;
    if (!best || score < best.score)
      best = { score, pl: r.pl, unplaced, moves: r.moves, seed: i };
    if (i >= 2 && Date.now() - t0 > dayBudgetMs) break;
  }

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
    .map(c => ({ id: c.id, name: c.name, order: c.order, fixedNet: c.fixedNet, teams: c.teams || [] }));

  const present = new Set(cats.flatMap(c => c.teams));
  for (const g of dayGames) { present.add(g.a); present.add(g.b); }

  return {
    day, dayId: day.id,
    slots: day.slots, slotMin: day.slotMin,
    netIds: [...(day.netIds || [])].sort((a, b) => a - b),
    cats, games: dayGames, blocked, avail,
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
      const res = packDay(ctx, opts);

      dayGames.forEach(g => {
        const p = res.place.get(g.key);
        g.slot = p ? p.slot : null;
        g.net  = p ? p.net  : null;
      });

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
