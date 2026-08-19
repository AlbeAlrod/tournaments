// ============================================================================
// league-ko.js — פיינל פור ומשחקי הצלבה. שלב 7 מתוך §14 במפרט.
//
// שני מסכים על אותם נתונים:
//   • פיינל פור (§11.1 / 3.9) — בראקט של 4 לכל ליגה: חצאי 1–4 ו-2–3, מקום 3–4,
//     וגמר. פורמט לכל שלב נקרא מ-L.formats (§2.6): "הטוב מ-3" מזין sets[],
//     מערכה יחידה מזינה sa/sb. 3.9.2 — מקום 1 בוחרת סלוט. 3.9.3 — החלפה
//     בקבוצה הגבוהה הבאה שלא העפילה, עם אישור ותיעוד.
//   • הצלבה (§11.2 / 3.11) — הכל מחושב **מלמטה**: N ו-N−1 יורדות, 1 ו-2 עולות,
//     N−2 מול 3 ו-N−3 מול 4. "מקום 13" אף פעם אינו קלט — הוא פלט (§2.7).
//
// חוזה §5.3: אין window.* globals, אין import של league.js. המצב החי והכלים
// שהמודול לא יכול לייבא מוזרקים דרך init(). הפעולות נושאות data-ko (מרחב שמות
// פרטי) ומטופלות במאזין שלנו ברמת המסמך, כדי ש-league.js לא יצטרך לגעת
// ב-ACT/NO_SAVE/handle — החיווט שם הוא שלוש שורות בלבד:
//
//   import KO from './league-ko.js?v=1';
//   KO.init({ getL: () => L, queueSave, repaint: paint, rankStandings,
//             teamName: TEAM_NAME, catName: CAT_NAME, validSet });
//   ... page === 'ko' ? KO.render() : ...      // ב-paint()
//
// עיצוב: אפס CSS חדש. הבראקט מחזר את מחלקות styles.css של הבראקט הקיים
// (.bscroll/.btree/.bround/.bmatch/.bteam/.champ-wrap), ההזנה מחזרת את
// .res-row/.res-inp של שלב 4, והשאר .sett-section/.sett-card/.stbl/.cf-btn.
// ============================================================================

import { escH } from './common.js?v=2';
// ‎?v=6‎ — אותה מחרוזת בדיוק כמו ב-league.js, ולא גרסה משלנו: מודול נטען פעם
// אחת לכל URL, ו-‎lang‎ הוא מצב פנימי שלו. מפרט גרסה אחר יוצר עותק שני של
// המילון עם שפה משלו, ואז מתג השפה בכותרת מזיז את הדירוג ולא את הבראקט.
// מי שמעדכנת את ה-‎?v‎ של league-i18n.js חייבת לעדכן גם כאן.
import { t, tData } from './league-i18n.js?v=7';

// ============================================================================
// ההקשר המוזרק מ-league.js
// ============================================================================
let X = null;   // { getL, queueSave, repaint, rankStandings, teamName, catName, validSet, role }

// רמת ההרשאה של הצופָה. ‎koGate‎ ב-league.js כבר חוסם את האירוע, אבל בלי זה
// הפקדים נראים פעילים: אפשר להקליד תוצאה ולראות אותה על המסך, והיא פשוט לא
// נשמרת. מסך שנראה עריך ואינו עריך גרוע ממסך נעול.
const ROLE = () => (X?.role ? X.role() : 2);
const RO   = lvl => ROLE() >= lvl ? '' : ' disabled';
// ‎RO‎ נועל פקד שכבר מרונדר, וזה נכון לאדמין שרואה כפתור של מאסטר: הוא יודע
// שהפעולה קיימת ושאיננה שלו. לצופָה זה לא נכון — פקד מנוטרל הוא עדיין
// הבטחה ("יש כאן משהו, פשוט לא עכשיו"), ולצופָה אין מה להבטיח. ‎ADMIN‎ מחליט
// מה **נבנה**, ‎RO‎ רק מה שנבנה נעול. הגדר עצמה (‎koGate‎ ב-league.js) לא זזה.
const ADMIN = () => ROLE() >= 1;
const L = () => X.getL();

// §10.1 — עותק זהה לזה שב-league.js. league.js לא מייצא אותו (§5.3 נועל את
// רשימת ה-exports שלו לארבעה שמות), ולכן הוא מוזרק דרך init ומה שכאן הוא רק
// רשת ביטחון לחיווט חלקי. מקור האמת נשאר §10.1 במפרט.
function localValidSet(win, lose, to, cap) {
  if (!(win > lose) || lose < 0 || win < 0) return false;
  if (cap == null) return (win === to && lose <= to - 2) || (win > to && win - lose === 2);
  return (win === to && lose <= to - 2)
      || (win > to && win < cap && win - lose === 2)
      || (win === cap && lose >= cap - 2);
}
const validSet = (w, l, to, cap) => (X?.validSet || localValidSet)(w, l, to, cap);

// ============================================================================
// מצב תצוגה (חי בדפדפן בלבד — לא נשמר במסמך)
// ============================================================================
let tab   = 'ff';    // 'ff' | 'cross'
let koCat = null;    // איזו ליגה מוצגת בבראקט

let bound = false;

function init(ctx) {
  X = ctx;
  attachListeners();
}

// ============================================================================
// עזרים
// ============================================================================

const teamName = id => (id ? X.teamName(id) : '');
const catName  = id => X.catName(id);
const cats     = () => (L().categories || []);

// ברירת מחדל לכל ליגה. mergeDefaults מספק את שלוש הליגות, אבל ליגה שנוספה
// אחרי שהמסמך נוצר לא תהיה שם — ולכן היצירה העצלה כאן.
function koOf(catId) {
  const K = (L().ko ||= {});
  return (K[catId] ||= { sfSlotChoice:null, sf:[], third:null, final:null, substitutions:[] });
}

// פורמט השלב מתוך המסמך (§2.6) — ההגדרות הן מקור האמת, לא קבוע בקוד.
const F_FALLBACK = { regular:{sets:1,to:18,by:2,cap:25}, sf:{sets:3,to:18,third:15,by:2,cap:25},
                     third:{sets:1,to:18,by:2,cap:25},   final:{sets:3,to:18,third:15,by:2,cap:25} };
const fmtOf = (catId, stage) => (L().formats?.[catId]?.[stage]) || F_FALLBACK[stage];

// תיאור הפורמט במילים — מופיע בכותרת כל משחק, כדי שהמנהלת לא תצטרך לזכור
// שליגה ב׳ משחקת חצי גמר עד 21 ואילו הגמר שלה הוא הטוב מ-3.
function fmtText(f) {
  if (!f) return '';
  const cap = f.cap == null ? t('ko.capNone') : t('ko.cap', { n:f.cap });
  return f.sets === 3
    ? t('ko.bo3', { sets:`${f.to}/${f.to}/${f.third ?? f.to}`, cap })
    : t('ko.oneSet', { to:f.to, cap });
}

// ============================================================================
// מגרש ושעה (§7.3) — נגזרים מיום השלב, עם דריסה ידנית
// ============================================================================
//
// הפיינל פור וההצלבה אינם עוברים במתזמן (§8.5: "הפיינל פור אינו משובץ לגריד"),
// ולכן למשחקים שלהם אין ‎net‎/‎slot‎ שמגיע מהלוז. אבל הצופָה שנכנסת לעמוד צריכה
// בדיוק את מה שהלוז הרגיל נותן לה — לאיזה מגרש ללכת ובאיזו שעה — ולכן:
//
//   • ברירת מחדל **נגזרת** מיום השלב (‎startTime‎ · ‎slotMin‎ · ‎netIds‎):
//     שני החצאים במקביל בסלוט הראשון, הגמר ומקום 3–4 במקביל בשני. ארבע
//     קבוצות ושני מגרשים — זה הסידור היחיד שאין בו קבוצה שממתינה סבב.
//   • המנהלת יכולה לדרוס, וזה מה שנשמר. ‎null‎ פירושו "אוטומטי", ולכן שינוי
//     בשעת ההתחלה של היום ממשיך להזיז את כל מה שלא נדרס ידנית.
//
// מיקום הפיינל פור נשמר ב-‎K.place‎ ולא על המשחק עצמו: ‎alignMatch‎ מאפס משחק
// שהזוג בו התחלף, והמגרש הוא תכונה של המשבצת בחוף — לא של הזוג ששיחק בה.
// בהצלבה יש שני משחקים בלבד ואין מפתח שלב, ולכן שם הוא יושב על המשחק
// ו-‎syncCross‎ גורר אותו מעבר לאיפוס (ראו שם).

const dayOf = id => (L().meta?.days || []).find(d => d.id === id) || null;

// עותק מקומי של שעון הסלוטים (§4.6). league.js מייצא ‎slotTime‎, אבל §5.3
// אוסר לייבא ממנו — וזו נוסחה של שורה אחת.
const hhmmToMin = v => { const [h, m] = String(v || '0:0').split(':').map(Number); return h * 60 + m; };
const minToHhmm = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
const slotTime  = (day, slot) => minToHhmm(hhmmToMin(day.startTime) + (slot - 1) * (day.slotMin || 0));

// ברירת המחדל לכל שלב: [אינדקס בתוך מגרשי היום, מספר הסלוט].
const FF_PLACE    = { sf0:[0, 1], sf1:[1, 1], third:[1, 2], final:[0, 2] };
const CROSS_PLACE = [[0, 1], [1, 1]];

const dayNets  = day => (day?.netIds?.length ? day.netIds : (L().meta?.nets || []).map(x => x.id));
const netOf    = id => (L().meta?.nets || []).find(x => x.id === id) || null;
const netName  = id => (id ? tData(netOf(id)?.name || ('מגרש ' + id)) : '');
const netColor = id => netOf(id)?.color || '';

// המיקום השמור של שלב בפיינל פור. אין כאן יצירה עצלה — הפונקציה נקראת מתוך
// רינדור, ומגע במסמך שם היה מייצר שמירה על כל צביעה.
const savedPlace = (catId, key) => (L().ko?.[catId]?.place || {})[key] || null;

// { net, slot, time } אחרי החלת הדריסה. ‎day‎ יכול להיות ‎null‎ (מסמך בלי היום
// הזה) — אז אין שעה, והמגרש נופל למגרש הראשון של הליגה.
function placeOf(day, saved, def) {
  const nets = dayNets(day);
  return {
    net:  saved?.net  ?? (nets[def[0]] ?? nets[0] ?? null),
    slot: saved?.slot ?? def[1],
    time: day?.startTime ? slotTime(day, saved?.slot ?? def[1]) : ''
  };
}

// הסימון עצמו — אותן שתי תוויות-מיקרו של ‎.pub-game‎ (§7.3): שם המגרש ואחריו
// השעה. הצבע אינו כאן אלא ב-‎koMarkStyle‎, כי הוא נישא על השפה המובילה של
// הכרטיס כולו ולא על התווית.
const koMark = p => (p.net ? `<span class="ko-net">${escH(netName(p.net))}</span>` : '')
                  + (p.time ? `<span class="ko-when num">${escH(p.time)}</span>` : '');
const koMarkStyle = p => (p.net && netColor(p.net)) ? ` style="--net:${escH(netColor(p.net))}"` : '';

// שני בוררי הדריסה. בלי כפתור "איפוס": האפשרות הראשונה בכל בורר היא
// "אוטומטי", ולכן חזרה לברירת המחדל היא בחירה ככל בחירה אחרת ולא פקד שלישי.
//
// ‎RO(2)‎ ולא ‎RO(1)‎: ‎KO_LEVEL‎ ב-league.js נותן ברירת מחדל 2 לכל פעולה שאינה
// רשומה בו, וleague.js אינו שלי כאן. בורר שנראה פתוח ונחסם ב-capture הוא
// בדיוק המסך שהמשימה הזאת באה לסלק.
function placeRow(day, saved, def, attrs) {
  const p    = placeOf(day, saved, def);
  const nets = dayNets(day);
  const auto = (label, val) => `<option value=""${val == null ? ' selected' : ''}>אוטומטי · ${escH(label)}</option>`;
  const slots = Math.max(1, day?.slots || 8);

  return `<div class="ko-place">
    <select class="text-inp ko-sel" ${attrs} data-f="net"${RO(2)}
      aria-label="מגרש">${auto(netName(p.net), saved?.net)}${
      nets.map(id => `<option value="${id}"${saved?.net === id ? ' selected' : ''}>${escH(netName(id))}</option>`).join('')}
    </select>
    <select class="text-inp ko-sel" ${attrs} data-f="slot"${RO(2)}
      aria-label="שעה">${auto(p.time || '—', saved?.slot)}${
      Array.from({ length:slots }, (_, i) => i + 1).map(sl =>
        `<option value="${sl}"${saved?.slot === sl ? ' selected' : ''}>${escH(day?.startTime ? slotTime(day, sl) : String(sl))}</option>`).join('')}
    </select>
  </div>`;
}

const emptyMatch = (a, b) => ({ a:a || null, b:b || null, sa:null, sb:null, sets:[], result:'pending' });

// משחק שמור נשאר רק אם שני המשתתפים בו לא השתנו. אם החצי גמר התהפך והגמר
// מולא כבר — התוצאה שנרשמה שייכת לזוג אחר, ולכן היא נמחקת ולא "נגררת".
function alignMatch(m, a, b) {
  if (m && m.a === (a || null) && m.b === (b || null)) {
    m.sets ||= []; m.result ||= 'pending';
    return m;
  }
  return emptyMatch(a, b);
}

// ============================================================================
// הכרעת משחק — מערכה יחידה או "הטוב מ-3"
// ============================================================================
//
// מוסכמת האחסון (§5.1 קובע את השדות; המשמעות מתועדת כאן):
//   מערכה יחידה → sa/sb הם הנקודות. sets נשאר ריק.
//   הטוב מ-3    → sets[] הוא [{a,b}] לכל מערכה, ו-sa/sb הם **מספר המערכות**
//                  שכל צד לקח (2:0 / 2:1). משחקי KO אינם נספרים בטבלת הליגה
//                  (computeStats רץ על L.games בלבד), ולכן אין כאן התנגשות
//                  עם ההפרש של §10.2.
//   result      → 'ok' כשההכרעה סופית, אחרת 'pending'. אין טכני בפיינל פור:
//                  קבוצה שאינה יכולה לשחק מוחלפת לפי 3.9.3.

// יעד המערכה ה-i בפורמט (מערכה שלישית מקוצרת ל-15 לפי 3.9.4).
const setTarget = (f, i) => (f.sets === 3 && i === 2 ? (f.third ?? f.to) : f.to);

function setWinner(f, i, s) {
  if (!s || s.a == null || s.b == null) return null;
  if (!validSet(Math.max(s.a, s.b), Math.min(s.a, s.b), setTarget(f, i), f.cap)) return null;
  return s.a > s.b ? 'a' : 'b';
}

// מחזיר { win, lose, wa, wb } או null אם עוד לא הוכרע.
function decide(m, f) {
  if (!m || !m.a || !m.b) return null;
  if (f.sets === 3) {
    let wa = 0, wb = 0;
    for (let i = 0; i < 3; i++) {
      const w = setWinner(f, i, m.sets?.[i]);
      if (!w) break;                       // מערכה חסרה או לא חוקית — עוצרים כאן
      w === 'a' ? wa++ : wb++;
      if (wa === 2 || wb === 2) break;
    }
    if (wa < 2 && wb < 2) return null;
    return wa === 2 ? { win:m.a, lose:m.b, wa, wb } : { win:m.b, lose:m.a, wa, wb };
  }
  if (m.sa == null || m.sb == null) return null;
  if (!validSet(Math.max(m.sa, m.sb), Math.min(m.sa, m.sb), f.to, f.cap)) return null;
  return m.sa > m.sb ? { win:m.a, lose:m.b } : { win:m.b, lose:m.a };
}

// מסנכרן sa/sb/result אחרי כל שינוי. ב"הטוב מ-3" sa/sb הם מניין המערכות.
function settle(m, f) {
  const d = decide(m, f);
  if (f.sets === 3) { m.sa = d ? d.wa : null; m.sb = d ? d.wb : null; }
  m.result = d ? 'ok' : 'pending';
  return d;
}

// ============================================================================
// המעפילות (3.9.1) וההחלפות (3.9.3)
// ============================================================================

const rankMap = ranked => Object.fromEntries(ranked.map(r => [r.row.id, r.rank]));

// ארבע המעפילות אחרי החלת ההחלפות, לפי הסדר. החלפה נשמרת לפי מזהי הקבוצות
// ולא לפי מקום, כדי שהיא תישאר תקפה גם אם הדירוג יזוז אחריה.
function seedsFor(catId) {
  const { ranked, alerts } = X.rankStandings(catId);
  const base  = ranked.slice(0, 4).map(r => r.row.id);
  const seeds = [...base];
  const subs  = koOf(catId).substitutions || [];
  for (const s of subs) {
    const i = seeds.indexOf(s.out);
    if (i >= 0) seeds[i] = s.in;
  }
  return { seeds, base, ranked, alerts, ranks: rankMap(ranked) };
}

// "הקבוצה שסיימה במקום הגבוה ביותר ולא העפילה" (3.9.3) — הראשונה בדירוג
// שאיננה כבר בבראקט. קבוצה שכבר הוחלפה החוצה (כלומר הודיעה שאינה יכולה
// להשתתף) אינה חוזרת כחלופה — אחרת החלפה שנייה הייתה מציבה אותה בחזרה.
function nextAlternate(ranked, seeds, subs) {
  const out = new Set([...seeds, ...(subs || []).map(s => s.out)]);
  for (const r of ranked) if (!out.has(r.row.id)) return r;
  return null;
}

// 3.9.2 — 1 משחקת מול 4 בכל מקרה; הבחירה היא באיזה סלוט. ברירת מחדל: הראשון.
function sfPairs(seeds, choice) {
  const top = [seeds[0], seeds[3]];   // 1–4
  const bot = [seeds[1], seeds[2]];   // 2–3
  return choice === 2 ? [bot, top] : [top, bot];
}

// ============================================================================
// סנכרון הבראקט אל הדירוג החי
// ============================================================================
//
// הבראקט אינו תצלום: הוא נגזר מהטבלה בכל רינדור. עדכון תוצאה בליגה הסדירה
// שמחליף בין מקום 2 ל-3 מזיז את הקבוצות בחצאי הגמר. משחק ששני משתתפיו לא
// השתנו שומר את תוצאתו; משחק שהמשתתפים בו התחלפו מתאפס (alignMatch).
// הכתיבה למסמך קורית רק כשמשהו באמת השתנה.
function syncKO(catId) {
  const K = koOf(catId);
  const before = JSON.stringify(K);
  const { seeds, ranked, alerts, ranks, base } = seedsFor(catId);

  if (seeds.length < 4) return { ready:false, seeds, ranked, alerts, ranks, base, K };

  // הזוג מחפש את עצמו בשני הסלוטים ולא רק בסלוט שלו: בחירת סלוט (3.9.2) רק
  // מחליפה בין החצאים, ולכן תוצאה שכבר הוזנה עוברת איתם במקום להימחק.
  const pairs  = sfPairs(seeds, K.sfSlotChoice);
  const stored = (K.sf || []).filter(Boolean);
  K.sf = pairs.map(([a, b]) => alignMatch(stored.find(m => m.a === a && m.b === b), a, b));

  const fSf = fmtOf(catId, 'sf');
  const d0 = decide(K.sf[0], fSf), d1 = decide(K.sf[1], fSf);

  K.final = alignMatch(K.final, d0?.win || null, d1?.win || null);
  K.third = alignMatch(K.third, d0?.lose || null, d1?.lose || null);

  settle(K.sf[0], fSf); settle(K.sf[1], fSf);
  settle(K.final, fmtOf(catId, 'final'));
  settle(K.third, fmtOf(catId, 'third'));

  if (JSON.stringify(K) !== before) X.queueSave();
  return { ready:true, seeds, ranked, alerts, ranks, base, K };
}

// ============================================================================
// רינדור — פיינל פור
// ============================================================================

const KEYS  = { sf0:'ko.sf0', sf1:'ko.sf1', third:'ko.third', final:'ko.final' };
const STAGE = { sf0:'sf', sf1:'sf', third:'third', final:'final' };

const getMatch = (K, key) => key === 'sf0' ? K.sf?.[0] : key === 'sf1' ? K.sf?.[1] : K[key];

export function renderFinalFour(container) {
  const html = ffHtml();
  if (container) container.innerHTML = html;
  return html;
}

function ffHtml() {
  const list = cats();
  if (!list.length) return empty(escH(t('ko.noCats')));

  if (!koCat || !list.find(c => c.id === koCat)) koCat = list[0].id;

  const nav = `<div class="court-filter">${list.map(c =>
    `<button class="cf-btn${c.id === koCat ? ' on' : ''}" data-ko="ko.cat" data-cat="${escH(c.id)}">${escH(tData(c.name))}</button>`
  ).join('')}</div>`;

  const teams = (L().roster?.[koCat] || []).length;
  if (teams < 4) return nav + empty(escH(t('ko.few', { cat:tData(catName(koCat)), n:teams })));

  const S = syncKO(koCat);
  if (!S.ready) return nav + empty(escH(t('ko.notReady')));

  // §2.5 — שוויון שנוגע לגבול הפיינל פור (מקומות 4–5) חוסם: התקנון לא מכריע
  // מי הרביעית, וההכרעה חייבת להירשם ידנית לפני שהבראקט נבנה.
  const blocking = S.alerts.filter(a => a.touchesF4);
  const seeding  = S.alerts.filter(a => !a.touchesF4 && a.start <= 4);

  // הטווח נשאר ‎<b class="num">‎ (בידוד דו-כיווני) ולכן הוא נבנה כאן ולא במילון;
  // מחרוזות המילון עצמן הן שלנו, והערכים שנכנסים אליהן הם מספרים או טקסט
  // שכבר עבר escH.
  const places = a => `<b class="num">${a.start}–${a.end}</b>`;
  const msgs =
    blocking.map(a => `<div class="sched-msg err">⛔ ${t('ko.tieBlock', { n:a.size, places:places(a) })}</div>`).join('') +
    seeding.map(a => `<div class="sched-msg warn">⚠ ${t('ko.tieSeed', { places:places(a) })}</div>`).join('');

  // §7.1 — הצופָה מקבלת את העץ ואת התוצאות ותו לא. טבלת המעפילות אינה נבנית
  // לה: היא חוזרת על מה שהבראקט (‎מק׳ N‎) והדירוג כבר מראים, וכפתור "החלפה"
  // מנוטרל הוא הבטחה שאין לה כיסוי.
  const mgr = ADMIN();

  if (blocking.length) return nav + msgs + (mgr ? qualifiersCard(S) + subsLog(S) : '');

  return nav + msgs
       + (mgr ? qualifiersCard(S) + choiceCard(S) : '')
       + bracket(S)
       + (mgr ? entryCard(S) + subsLog(S) : '');
}

// ── כרטיס המעפילות + כפתור ההחלפה (3.9.1 + 3.9.3) ──────────────────────────
function qualifiersCard(S) {
  const rows = S.seeds.map((id, i) => {
    const sub = id !== S.base[i];
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="stand-name">${escH(teamName(id))}${sub
        ? ` <span class="status-badge badge-pending">מחליפה</span>` : ''}</td>
      <td class="num">${S.ranks[id] ?? '—'}</td>
      <td style="text-align:left">
        <button class="cf-btn" data-ko="ko.sub" data-cat="${escH(koCat)}" data-i="${i}"${RO(2)}>החלפה</button>
      </td>
    </tr>`;
  }).join('');

  return `<div class="sett-section">
    <div class="sett-section-title">המעפילות — ${escH(catName(koCat))}</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>שיבוץ</th><th>קבוצה</th><th>מקום בטבלה</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:10px">ארבעת המקומות הראשונים.
      "החלפה" מציבה במקומה של קבוצה שאינה יכולה להשתתף את
      <b>הקבוצה הגבוהה ביותר שלא העפילה</b>, ומתעדת את זה למטה.</span>
  </div>`;
}

// ── 3.9.2 — בחירת סלוט למקום 1 ──────────────────────────────────────────────
function choiceCard(S) {
  const cur = S.K.sfSlotChoice === 2 ? 2 : 1;
  const btn = n => `<button class="cf-btn${cur === n ? ' on' : ''}"
      data-ko="ko.choice" data-cat="${escH(koCat)}" data-slot="${n}"${RO(2)}>חצי גמר ${n === 1 ? '①' : '②'}</button>`;
  return `<div class="sett-section">
    <div class="sett-section-title">בחירת חצי הגמר — מקום 1</div>
    <div class="court-filter" style="margin-bottom:8px">${btn(1)}${btn(2)}</div>
    <span class="sett-desc">לקבוצה שסיימה במקום 1 יש זכות לבחור באיזה חצי גמר תשחק.
      היריבה היא מקום 4 בכל מקרה, ולכן הבחירה היא בסלוט בלבד; מקומות 2–3 נכנסים לסלוט השני.
      כרגע: <b>${escH(teamName(S.seeds[0]))}</b> משחקת בחצי גמר ${cur === 1 ? '①' : '②'}.</span>
  </div>`;
}

// ── הבראקט ─────────────────────────────────────────────────────────────────
function bracket(S) {
  const box = key => matchBox(S, key);
  const champ = champBox(S);

  return `<div class="sett-section">
    <div class="sett-section-title">${escH(t('ko.bracket'))}</div>
    <div class="bscroll" data-sk="ko-bracket" id="ko-bracket">
      <div class="btree">
        <div class="bround">
          <div class="brnd-title">${escH(t('ko.rndSemis'))}</div>
          <div class="brnd-matches">
            <div class="bmatch-wrap">${box('sf0')}</div>
            <div class="bmatch-wrap" style="margin-top:46px">${box('sf1')}</div>
          </div>
        </div>
        <div class="bround">
          <div class="brnd-title">${escH(t('ko.rndFinal'))}</div>
          <div class="brnd-matches" style="padding-top:56px">
            <div class="bmatch-wrap">${box('final')}</div>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:12px">
            ${box('third')}
          </div>
        </div>
      </div>
    </div>
    ${champ}
  </div>`;
}

function matchBox(S, key) {
  const f = fmtOf(koCat, STAGE[key]);
  const m = getMatch(S.K, key) || emptyMatch(null, null);
  const d = decide(m, f);
  const p = placeOf(dayOf('ff'), savedPlace(koCat, key), FF_PLACE[key]);

  const ph = key === 'final' ? [t('ko.wSf1'), t('ko.wSf2')]
           : key === 'third' ? [t('ko.lSf1'), t('ko.lSf2')]
           : ['', ''];

  const side = (id, i) => {
    const known = !!id;
    const win   = d && d.win === id;
    const score = f.sets === 3
      ? (m.sa != null ? (i === 0 ? m.sa : m.sb) : '')
      : ((i === 0 ? m.sa : m.sb) ?? '');
    const seed = known && key.startsWith('sf') ? S.seeds.indexOf(id) + 1 : 0;
    return `<div class="bteam${win ? ' win' : ''}${known ? '' : ' tbd'}">
      <span class="bname">${escH(known ? teamName(id) : ph[i])}</span>
      ${seed ? `<span class="bsc ko-seed">${escH(t('ko.seed', { n:seed }))}</span>` : ''}
      ${score !== '' ? `<span class="bsc num">${score}</span>` : ''}
    </div>`;
  };

  // שורה תחתונה אחת, לא שתיים: כשיש תוצאה פירוט המערכות הוא מה שקוראים,
  // וכשאין — הפורמט הוא מה שצריך לדעת. כרטיס ברוחב 165px לא סובל את שתיהן.
  const setList = f.sets === 3
    ? (m.sets || []).filter(x => x && x.a != null && x.b != null).map(x => `${x.a}:${x.b}`).join(' · ')
    : '';
  const foot = setList
    ? `<span class="ko-foot num">${escH(setList)}</span>`
    : `<span class="ko-foot">${escH(fmtText(f))}</span>`;

  // אותו כרטיס של ‎.pub-game‎ (§7.3): שם השלב בקצה הקריאה, המגרש והשעה
  // כתוויות-מיקרו, וצבע המגרש על השפה המובילה דרך ‎--net‎.
  return `<div class="bmatch-box ko-box"${koMarkStyle(p)}>
    <div class="ko-head"><span class="ko-stage">${escH(t(KEYS[key]))}</span>${koMark(p)}</div>
    <div class="bmatch">${side(m.a, 0)}${side(m.b, 1)}</div>
    ${foot}
  </div>`;
}

function champBox(S) {
  const d = decide(S.K.final, fmtOf(koCat, 'final'));
  if (!d) return '';
  const third = decide(S.K.third, fmtOf(koCat, 'third'));
  return `<div class="champ-wrap">
    <div class="ci">${escH(t('ko.champOf', { cat:tData(catName(koCat)) }))}</div>
    <div class="champ-name">${escH(teamName(d.win))}</div>
    <span class="sett-desc" style="margin-top:8px">${escH(t('ko.place2'))}: ${escH(teamName(d.lose))}${
      third ? ` · ${escH(t('ko.place3'))}: ${escH(teamName(third.win))}` : ''}</span>
  </div>`;
}

// ── הזנת הניקוד ────────────────────────────────────────────────────────────
function entryCard(S) {
  const order = ['sf0', 'sf1', 'third', 'final'];
  const cards = order.map(key => matchEntry(S, key)).join('');
  return `<div class="sett-section">
    <div class="sett-section-title">הזנת תוצאות</div>
    ${cards}
    <span class="sett-desc" style="margin-top:12px">כל תוצאה בהפרש 2.
      מנצחת חצי גמר עולה לגמר, מפסידה יורדת למשחק על מקום 3–4 — אוטומטית.
      שינוי בטבלת הליגה מזיז את המשובצות; משחק ששני משתתפיו התחלפו מתאפס.</span>
  </div>`;
}

function matchEntry(S, key) {
  const f = fmtOf(koCat, STAGE[key]);
  const m = getMatch(S.K, key) || emptyMatch(null, null);
  const d = decide(m, f);

  const head = `<div class="sett-card-title" style="margin-bottom:2px">
    ${escH(t(KEYS[key]))} <span class="muted">· ${escH(fmtText(f))}</span>
    ${d ? `<span class="status-badge badge-approved">הסתיים</span>` : ''}
  </div>`
    // אותו מגרש ואותה שעה שהצופָה רואה בעץ — כאן הם ניתנים לדריסה.
    + placeRow(dayOf('ff'), savedPlace(koCat, key), FF_PLACE[key],
               `data-ko="ko.place" data-cat="${escH(koCat)}" data-key="${key}"`);

  if (!m.a || !m.b) return `<div style="margin-bottom:18px">${head}
    <span class="sett-desc">ממתין לתוצאות חצאי הגמר.</span></div>`;

  const nameA = escH(teamName(m.a)), nameB = escH(teamName(m.b));

  const inp = (i, sideKey, val, disabled) => `<input class="text-inp res-inp" type="number" min="0" max="60"
      id="ko-${escH(koCat)}-${key}-${i}-${sideKey}" value="${val ?? ''}"
      data-ko="ko.score" data-cat="${escH(koCat)}" data-key="${key}" data-i="${i}"${RO(1)}
      data-side="${sideKey}"${disabled ? ' disabled' : ''}/>`;

  const rowFor = (i, sa, sb) => {
    const to = setTarget(f, i);
    const w  = f.sets === 3 ? setWinner(f, i, { a:sa, b:sb })
             : (sa != null && sb != null && validSet(Math.max(sa, sb), Math.min(sa, sb), f.to, f.cap)
                ? (sa > sb ? 'a' : 'b') : null);
    const filled = sa != null && sb != null;
    const bad = filled && !w;
    return `<div class="res-row${bad ? ' invalid' : ''}">
      <span class="res-team${w === 'a' ? ' win' : ''}">${nameA}</span>
      <span class="res-score">
        ${f.sets === 3 ? `<b>מערכה ${i + 1}</b>` : ''}
        ${inp(i, 'a', sa)}<b>:</b>${inp(i, 'b', sb)}
      </span>
      <span class="res-team${w === 'b' ? ' win' : ''}" style="text-align:left">${nameB}</span>
      <span class="res-meta"><span class="muted">עד ${to}</span></span>
      ${bad ? `<span class="score-err">תוצאה לא חוקית — עד ${to}${
        f.cap ? `, תקרה ${f.cap}` : ', ללא תקרה'}, הפרש 2</span>` : ''}
    </div>`;
  };

  let rows;
  if (f.sets === 3) {
    // המערכה השלישית נפתחת רק כשהיא באמת נדרשת (1:1) — או אם כבר הוזנה.
    const s = i => m.sets?.[i] || {};
    const w0 = setWinner(f, 0, m.sets?.[0]), w1 = setWinner(f, 1, m.sets?.[1]);
    const needThird = (w0 && w1 && w0 !== w1) || (m.sets?.[2] && (s(2).a != null || s(2).b != null));
    rows = rowFor(0, s(0).a ?? null, s(0).b ?? null)
         + rowFor(1, s(1).a ?? null, s(1).b ?? null)
         + (needThird ? rowFor(2, s(2).a ?? null, s(2).b ?? null) : '');
  } else {
    rows = rowFor(0, m.sa, m.sb);
  }

  const summary = d && f.sets === 3
    ? `<span class="sett-desc">${escH(teamName(d.win))} ניצחה ${d.wa > d.wb ? d.wa : d.wb}:${d.wa > d.wb ? d.wb : d.wa} במערכות.</span>`
    : '';

  return `<div style="margin-bottom:18px">${head}${rows}${summary}</div>`;
}

// ── תיעוד ההחלפות (3.9.3) ──────────────────────────────────────────────────
function subsLog(S) {
  const subs = S.K.substitutions || [];
  if (!subs.length) return '';
  const rows = subs.map((s, i) => {
    const stale = !S.base.includes(s.out);
    return `<tr>
      <td class="stand-name">${escH(teamName(s.out))}</td>
      <td class="stand-name">${escH(teamName(s.in))}${
        stale ? ` <span class="muted">(הדירוג השתנה — ההחלפה כבר לא חלה)</span>` : ''}</td>
      <td class="num">${escH(s.at || '')}</td>
      <td style="text-align:left"><button class="cf-btn"${RO(2)} data-ko="ko.unsub"
        data-cat="${escH(koCat)}" data-i="${i}">ביטול</button></td>
    </tr>`;
  }).join('');
  return `<div class="sett-section">
    <div class="sett-section-title">החלפות שנרשמו</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>יצאה</th><th>נכנסה</th><th>מתי</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ============================================================================
// רינדור — משחקי הצלבה (§11.2 / 3.11)
// ============================================================================
//
// ⚠️ הכל נספר מלמטה. "שלישית מהסוף" ולא "מקום 13": אם יירשמו 13 קבוצות במקום
// 15, מקום 13 הוא האחרונה וכל המנגנון מתהפך (§2.7). מספרי המקומות שמוצגים
// למנהלת הם **פלט** של החישוב.

const MIN_N = 6, MIN_M = 4;   // תנאי הסף של §2.7

function crossPlan() {
  const r1 = X.rankStandings('liga1');
  const r2 = X.rankStandings('liga2');
  const A = r1.ranked, B = r2.ranked;
  const N = A.length, M = B.length;
  if (N < MIN_N || M < MIN_M) return { ok:false, N, M, A, B };

  const fromEnd = k => A[N - k];    // k=1 האחרונה · k=2 שנייה מהסוף · k=3 שלישית מהסוף

  return {
    ok:true, N, M, A, B,
    down:  [fromEnd(2), fromEnd(1)],          // N−1 ו-N — יורדות אוטומטית (3.11.1)
    up:    [B[0], B[1]],                      // 1 ו-2 — עולות אוטומטית (3.11.2)
    pairs: [ { a:fromEnd(3), b:B[2], label:'ko.x.pair3' },   // 3.11.3
             { a:fromEnd(4), b:B[3], label:'ko.x.pair4' } ], // 3.11.4
    alerts: [...r1.alerts.map(a => ({ ...a, cat:'liga1' })),
             ...r2.alerts.map(a => ({ ...a, cat:'liga2' }))]
  };
}

// אותה הצמדה כמו בבראקט: זוג שהשתנה מאפס את התוצאה שנרשמה לו.
// המודל של crossover (§5.1) הוא { a, b, sa, sb } בלבד — מערכה יחידה, בלי sets.
function syncCross(P) {
  const arr = (L().crossover ||= []);
  const before = JSON.stringify(arr);
  const next = P.pairs.map((p, i) => {
    const a = p.a?.row.id || null, b = p.b?.row.id || null;
    const cur = arr[i];
    if (cur && cur.a === a && cur.b === b) return cur;
    // המשבצת (מגרש · שעה) שייכת ללוז ולא לזוג: זוג שהתחלף מאפס את התוצאה,
    // אבל המשחק עדיין באותה שעה ובאותו מגרש. נכתב רק אם נדרס בפועל, כדי
    // שהמסמך לא יתמלא ב-‎null‎ עבור מה שממילא נגזר.
    const g = { a, b, sa:null, sb:null };
    if (cur?.net  != null) g.net  = cur.net;
    if (cur?.slot != null) g.slot = cur.slot;
    return g;
  });
  L().crossover = next;
  if (JSON.stringify(next) !== before) X.queueSave();
  return next;
}

export function renderCrossover(container) {
  const html = crossHtml();
  if (container) container.innerHTML = html;
  return html;
}

function crossHtml() {
  const has1 = (L().roster?.liga1 || []).length, has2 = (L().roster?.liga2 || []).length;
  if (!has1 || !has2) return empty(escH(t('ko.x.empty')));

  const P = crossPlan();

  if (!P.ok) return `<div class="sched-msg err">⛔ ${escH(t('ko.x.small', {
      cat1:tData(catName('liga1')), n1:P.N,
      more:P.M < MIN_M ? t('ko.x.smallAlso', { cat2:tData(catName('liga2')), n2:P.M }) : '',
      minN:MIN_N, minM:MIN_M }))}</div>` + finalTables(P);

  const games = syncCross(P);
  const f = fmtOf('liga1', 'regular');
  const mgr = ADMIN();

  // אזהרת §2.5 רק כששוויון לא מוכרע נוגע למקומות שהמנגנון קורא בהם.
  const hot1 = new Set([P.N, P.N - 1, P.N - 2, P.N - 3]);
  const hot2 = new Set([1, 2, 3, 4, 5]);
  const warn = P.alerts.filter(a => {
    const hot = a.cat === 'liga1' ? hot1 : hot2;
    for (let r = a.start; r <= a.end; r++) if (hot.has(r)) return true;
    return false;
  }).map(a => `<div class="sched-msg warn">⚠ ${t('ko.x.tie', { cat:escH(tData(catName(a.cat))),
      places:`<b class="num">${a.start}–${a.end}</b>` })}</div>`).join('');

  const auto = `<div class="sett-section">
    <div class="sett-section-title">${escH(t('ko.x.autoT'))}</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>${escH(t('col.team'))}</th><th>${escH(t('ko.x.from'))}</th>
        <th>${escH(t('ko.x.rank'))}</th><th>${escH(t('ko.x.to'))}</th></tr></thead>
      <tbody>
        ${P.down.map((r, i) => `<tr>
          <td class="stand-name">${escH(teamName(r.row.id))}</td>
          <td>${escH(tData(catName('liga1')))}</td>
          <td class="num">${r.rank} <span class="muted">(${escH(t(i === 0 ? 'ko.x.last2' : 'ko.x.last'))})</span></td>
          <td><span class="status-badge badge-rejected">${escH(t('ko.x.down', { cat:tData(catName('liga2')) }))}</span></td></tr>`).join('')}
        ${P.up.map(r => `<tr>
          <td class="stand-name">${escH(teamName(r.row.id))}</td>
          <td>${escH(tData(catName('liga2')))}</td>
          <td class="num">${r.rank}</td>
          <td><span class="status-badge badge-approved">${escH(t('ko.x.up', { cat:tData(catName('liga1')) }))}</span></td></tr>`).join('')}
      </tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:10px">${t('ko.x.autoFoot', {
      n:P.N, cat:escH(tData(catName('liga1'))),
      places:`<b class="num">${P.N - 1}</b> · <b class="num">${P.N}</b>` })}</span>
  </div>`;

  // הצופָה מקבלת בדיוק את כרטיס הלוז (§7.3) — מגרש, שעה, ותוצאה. המנהלת
  // מקבלת את שורת ההזנה, עם אותו סימון ועם בוררי הדריסה מעליה.
  const rows = P.pairs.map((p, i) => {
    const g = games[i];
    const dec = decide({ ...g, sets:[] }, f);
    const pl = placeOf(dayOf('cross'), g, CROSS_PLACE[i]);
    return mgr ? crossEntry(p, g, dec, f, i, pl) : crossCard(p, g, dec, i, pl);
  }).join('');

  const play = `<div class="sett-section">
    <div class="sett-section-title">${escH(t('ko.x.gamesT'))}</div>
    ${mgr ? rows : `<div class="pub-games">${rows}</div>`}
    <span class="sett-desc" style="margin-top:10px">${escH(t('ko.x.gamesFoot', {
      cat1:tData(catName('liga1')), cat2:tData(catName('liga2')) }))}</span>
  </div>`;

  return warn + auto + play + nextSeason(P, games, f) + finalTables(P);
}

// כרטיס קריאה למשחק הצלבה — ‎.pub-game‎ עצמו, בלי עותק שני של הדפוס (§7.3).
function crossCard(p, g, dec, i, pl) {
  const wa = !!dec && dec.win === g.a, wb = !!dec && dec.win === g.b;
  const done = g.sa != null && g.sb != null;
  const score = done
    ? `<span class="pub-score"><b class="num${wa ? ' win' : ''}">${g.sa}</b><i>:</i><b class="num${wb ? ' win' : ''}">${g.sb}</b></span>`
    : `<span class="pub-score pub-vs">${escH(t('sched.vs'))}</span>`;
  return `<div class="pub-game"${koMarkStyle(pl)}>
    <span class="pub-net">${escH(netName(pl.net))}</span>
    ${pl.time ? `<span class="pub-when num">${escH(pl.time)}</span>` : ''}
    <span class="pub-team${wa ? ' win' : ''}">${escH(teamName(p.a.row.id))}</span>
    ${score}
    <span class="pub-team${wb ? ' win' : ''}">${escH(teamName(p.b.row.id))}</span>
    <span class="pub-cat">${escH(t(p.label))}</span>
  </div>`;
}

// שורת ההזנה (אדמין ומעלה) — כפי שהייתה, עם שורת המיקום מעליה.
function crossEntry(p, g, dec, f, i, pl) {
  const nameA = escH(teamName(p.a.row.id)), nameB = escH(teamName(p.b.row.id));
  const bad = g.sa != null && g.sb != null && !dec;
  const inp = side => `<input class="text-inp res-inp" type="number" min="0" max="60"
      id="ko-cross-${i}-${side}" value="${(side === 'sa' ? g.sa : g.sb) ?? ''}"
      data-ko="ko.cross" data-i="${i}" data-side="${side}"${RO(1)}/>`;
  return `<div style="margin-bottom:16px">
    <div class="sett-card-title" style="margin-bottom:2px">${escH(t('ko.x.game', { n:i + 1 }))}
      <span class="muted">· ${escH(t(p.label))} · ${escH(fmtText(f))}</span>
      ${dec ? `<span class="status-badge badge-approved">הסתיים</span>` : ''}</div>
    ${placeRow(dayOf('cross'), g, CROSS_PLACE[i], `data-ko="ko.xplace" data-i="${i}"`)}
    <div class="res-row${bad ? ' invalid' : ''}">
      <span class="res-team${dec?.win === g.a ? ' win' : ''}">${nameA}
        <span class="muted">(א׳ · מקום ${p.a.rank})</span></span>
      <span class="res-score">${inp('sa')}<b>:</b>${inp('sb')}</span>
      <span class="res-team${dec?.win === g.b ? ' win' : ''}" style="text-align:left">${nameB}
        <span class="muted">(ב׳ · מקום ${p.b.rank})</span></span>
      <span class="res-meta"><span class="muted">עד ${f.to}</span></span>
      ${bad ? `<span class="score-err">תוצאה לא חוקית — עד ${f.to}${
        f.cap ? `, תקרה ${f.cap}` : ', ללא תקרה'}, הפרש 2</span>` : ''}
    </div>
  </div>`;
}

// הרכב הליגות לעונה הבאה — נגזר, ומופיע ברגע ששתי ההצלבות הוכרעו.
function nextSeason(P, games, f) {
  const decs = games.map(g => decide({ ...g, sets:[] }, f));
  const done = decs.every(Boolean);

  const downIds = new Set(P.down.map(r => r.row.id));
  const upIds   = new Set(P.up.map(r => r.row.id));
  const loseTo2 = new Set(), winTo1 = new Set();
  decs.forEach((d, i) => {
    if (!d) return;
    const A = P.pairs[i].a.row.id;                 // מליגה ראשונה
    if (d.win === A) { /* נשארת בא׳, היריבה נשארת בב׳ */ }
    else { loseTo2.add(A); winTo1.add(d.win); }
  });

  const nm = r => teamName(r.row.id);
  const inA = P.A.filter(r => !downIds.has(r.row.id) && !loseTo2.has(r.row.id)).map(nm)
    .concat(P.up.map(nm), P.B.filter(r => winTo1.has(r.row.id)).map(nm));
  const inB = P.A.filter(r => downIds.has(r.row.id) || loseTo2.has(r.row.id)).map(nm)
    .concat(P.B.filter(r => !upIds.has(r.row.id) && !winTo1.has(r.row.id)).map(nm));

  const col = (title, names) => `<div class="sett-card">
    <div class="sett-card-title">${escH(title)} <span class="muted">(${names.length})</span></div>
    <ol style="margin:0;padding-inline-start:20px;font-size:13px;line-height:1.9">
      ${names.map(n => `<li>${escH(n)}</li>`).join('')}
    </ol></div>`;

  return `<div class="sett-section">
    <div class="sett-section-title">${escH(t('ko.x.nextT'))}</div>
    ${done ? '' : `<div class="sched-msg warn">${escH(t('ko.x.nextWait'))}</div>`}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
      ${col(tData(catName('liga1')), inA)}${col(tData(catName('liga2')), inB)}
    </div>
  </div>`;
}

// שתי הטבלאות הסופיות — מוצגות תמיד, וגם כשהסף לא מתקיים (§2.7 מחייב).
function finalTables(P) {
  const tbl = (title, rows) => `<div class="sett-card">
    <div class="sett-card-title">${escH(title)}</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>${escH(t('col.rank'))}</th><th>${escH(t('col.team'))}</th>
        <th>${escH(t('col.pts'))}</th><th>${escH(t('col.diff'))}</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="num">${r.rank}</td>
        <td class="stand-name">${escH(teamName(r.row.id))}</td>
        <td class="num">${r.row.pts}</td>
        <td class="num">${r.row.diff > 0 ? '+' : ''}${r.row.diff}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  return `<div class="sett-section">
    <div class="sett-section-title">${escH(t('ko.x.tablesT'))}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
      ${tbl(tData(catName('liga1')), P.A)}${tbl(tData(catName('liga2')), P.B)}
    </div>
  </div>`;
}

// ============================================================================
// המסך המלא (שתי הלשוניות) — נקודת החיווט הנוחה ל-league.js
// ============================================================================

export function render(container) {
  const nav = `<div class="court-filter">
    <button class="cf-btn${tab === 'ff' ? ' on' : ''}" data-ko="ko.tab" data-tab="ff">${escH(t('ko.tab.ff'))}</button>
    <button class="cf-btn${tab === 'cross' ? ' on' : ''}" data-ko="ko.tab" data-tab="cross">${escH(t('ko.tab.cross'))}</button>
  </div>`;
  const html = nav + (tab === 'ff' ? ffHtml() : crossHtml());
  if (container) container.innerHTML = html;
  return html;
}

const empty = msg => `<div class="sett-section empty"><p>${msg}</p></div>`;

// ============================================================================
// פעולות
// ============================================================================
//
// מרחב שמות פרטי (data-ko) עם מאזין משלנו ברמת המסמך, ולא data-act של
// league.js: כך פעולת תצוגה (החלפת לשונית/ליגה) לא כותבת את המסמך כולו,
// ובלי לגעת ב-ACT/NO_SAVE/handle שם. ערך ההחזרה:
//   'view'    — רק רינדור מחדש, בלי שמירה
//   false     — לא קרה כלום
//   undefined — שמירה + רינדור

const ACT = {
  'ko.tab': el => { tab = el.dataset.tab; return 'view'; },
  'ko.cat': el => { koCat = el.dataset.cat; return 'view'; },

  // 3.9.2 — הבחירה נשמרת, וה-sync מעביר את הזוגות בין הסלוטים.
  'ko.choice': el => { koOf(el.dataset.cat).sfSlotChoice = +el.dataset.slot === 2 ? 2 : 1; },

  // 3.9.3 — החלפה בקבוצה הגבוהה ביותר שלא העפילה, עם אישור ותיעוד.
  'ko.sub': el => {
    const cat = el.dataset.cat, i = +el.dataset.i;
    const { seeds, ranked, ranks } = seedsFor(cat);
    const out = seeds[i];
    const alt = nextAlternate(ranked, seeds, koOf(cat).substitutions);
    if (!alt) { alert('אין קבוצה נוספת בטבלה שאפשר להעלות במקומה.'); return false; }
    if (!confirm(`"${teamName(out)}" (מקום ${ranks[out] ?? '?'}) לא יכולה להשתתף בפיינל פור?\n\n` +
      `היא תוחלף ב"${alt.row.name}" — הקבוצה הגבוהה ביותר שלא העפילה (מקום ${alt.rank}).`))
      return false;
    (koOf(cat).substitutions ||= []).push({
      out, in: alt.row.id, outRank: ranks[out] ?? null, inRank: alt.rank,
      at: new Date().toISOString().slice(0, 10)
    });
  },

  'ko.unsub': el => {
    const cat = el.dataset.cat, i = +el.dataset.i;
    const subs = koOf(cat).substitutions || [];
    const s = subs[i]; if (!s) return false;
    if (!confirm(`לבטל את ההחלפה "${teamName(s.out)}" ← "${teamName(s.in)}"?`)) return false;
    subs.splice(i, 1);
  },

  // ניקוד פיינל פור. מלכודת 3: change נורה גם במעבר מהתיבה הראשונה לשנייה,
  // ולכן רינדור מחדש רק כשהמערכה *שלמה* או שהמשחק כבר היה מוכרע — אחרת
  // ה-DOM נבנה מחדש תחת האצבע והערך השני נמחק.
  'ko.score': el => {
    const cat = el.dataset.cat, key = el.dataset.key, i = +el.dataset.i, side = el.dataset.side;
    const K = koOf(cat), m = getMatch(K, key);
    if (!m) return false;
    const f = fmtOf(cat, STAGE[key]);
    const wasOk = m.result === 'ok';
    const v = el.value === '' ? null : Math.max(0, Math.floor(+el.value) || 0);

    if (f.sets === 3) {
      m.sets ||= [];
      while (m.sets.length <= i) m.sets.push({ a:null, b:null });
      m.sets[i][side] = v;
      // מערכה שהתרוקנה גוררת איתה את המערכות שאחריה — אין מערכה 3 בלי 2.
      if (v == null && m.sets[i].a == null && m.sets[i].b == null) m.sets.length = i;
    } else {
      m[side === 'a' ? 'sa' : 'sb'] = v;
    }

    settle(m, f);
    const complete = f.sets === 3
      ? (m.sets[i] && m.sets[i].a != null && m.sets[i].b != null)
      : (m.sa != null && m.sb != null);
    if (!complete && !wasOk) { X.queueSave(); return false; }
  },

  // דריסת המגרש/השעה. ערך ריק = "אוטומטי", ולכן הוא נמחק מהמסמך ולא נשמר
  // כ-‎null‎ — מסמך שלא נגעו בו נשאר בדיוק כפי שהיה לפני השלב הזה.
  'ko.place': el => {
    const P = (koOf(el.dataset.cat).place ||= {});
    const rec = (P[el.dataset.key] ||= {});
    if (el.value === '') delete rec[el.dataset.f]; else rec[el.dataset.f] = +el.value;
  },

  'ko.xplace': el => {
    const g = (L().crossover || [])[+el.dataset.i];
    if (!g) return false;
    if (el.value === '') delete g[el.dataset.f]; else g[el.dataset.f] = +el.value;
  },

  // ניקוד הצלבה — מערכה יחידה, מודל { a, b, sa, sb } (§5.1).
  'ko.cross': el => {
    const i = +el.dataset.i, side = el.dataset.side;
    const g = (L().crossover || [])[i];
    if (!g) return false;
    const f = fmtOf('liga1', 'regular');
    const wasOk = !!decide({ ...g, sets:[] }, f);
    g[side] = el.value === '' ? null : Math.max(0, Math.floor(+el.value) || 0);
    const complete = g.sa != null && g.sb != null;
    if (!complete && !wasOk) { X.queueSave(); return false; }
  }
};

// ============================================================================
// חיווט — מאזין אחד ברמת המסמך ששורד כל רינדור (דפוס ה-delegation של שלב 2)
// ============================================================================

function attachListeners() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-ko]');
    if (el && /^(BUTTON|A)$/.test(el.tagName)) run(el, e);
  });
  // שדות נשמרים ב-blur ולא בהקלדה (מלכודת 3)
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-ko]');
    if (el && /^(INPUT|SELECT)$/.test(el.tagName)) run(el, e);
  });
}

function run(el, e) {
  const fn = ACT[el.dataset.ko];
  if (!fn) return;
  const r = fn(el, e);
  if (r === false) return;
  if (r !== 'view') X.queueSave();
  repaint();
}

// רינדור מחדש בלי שהדף יקפוץ למעלה. league.js מייצא paint() (ולא
// paintKeepScroll), ולכן שמירת הגלילה יושבת כאן — כולל אזורים פנימיים
// עם data-sk, כדי שהבראקט לא יחזור לתחילתו בכל הזנה.
function repaint() {
  const x = window.scrollX, y = window.scrollY, inner = {};
  document.querySelectorAll('[data-sk]').forEach(el => inner[el.dataset.sk] = { t:el.scrollTop, l:el.scrollLeft });
  X.repaint();
  void document.body.offsetHeight;
  window.scrollTo(x, y);
  document.querySelectorAll('[data-sk]').forEach(el => {
    const v = inner[el.dataset.sk];
    if (v) { el.scrollTop = v.t; el.scrollLeft = v.l; }
  });
}

export { init };
export default { init, render, renderFinalFour, renderCrossover };
