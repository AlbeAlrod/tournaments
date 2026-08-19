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

// ============================================================================
// ההקשר המוזרק מ-league.js
// ============================================================================
let X = null;   // { getL, queueSave, repaint, rankStandings, teamName, catName, validSet, role }

// רמת ההרשאה של הצופָה. ‎koGate‎ ב-league.js כבר חוסם את האירוע, אבל בלי זה
// הפקדים נראים פעילים: אפשר להקליד תוצאה ולראות אותה על המסך, והיא פשוט לא
// נשמרת. מסך שנראה עריך ואינו עריך גרוע ממסך נעול.
const ROLE = () => (X?.role ? X.role() : 2);
const RO   = lvl => ROLE() >= lvl ? '' : ' disabled';
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
  const cap = f.cap == null ? 'ללא תקרה' : `תקרה ${f.cap}`;
  return f.sets === 3
    ? `הטוב מ-3 · ${f.to}/${f.to}/${f.third ?? f.to} · ${cap}`
    : `מערכה עד ${f.to} · ${cap}`;
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

const KEYS  = { sf0:'חצי גמר ①', sf1:'חצי גמר ②', third:'מקום 3–4', final:'גמר' };
const STAGE = { sf0:'sf', sf1:'sf', third:'third', final:'final' };

const getMatch = (K, key) => key === 'sf0' ? K.sf?.[0] : key === 'sf1' ? K.sf?.[1] : K[key];

export function renderFinalFour(container) {
  const html = ffHtml();
  if (container) container.innerHTML = html;
  return html;
}

function ffHtml() {
  const list = cats();
  if (!list.length) return empty('אין ליגות מוגדרות.');

  if (!koCat || !list.find(c => c.id === koCat)) koCat = list[0].id;

  const nav = `<div class="court-filter">${list.map(c =>
    `<button class="cf-btn${c.id === koCat ? ' on' : ''}" data-ko="ko.cat" data-cat="${escH(c.id)}">${escH(c.name)}</button>`
  ).join('')}</div>`;

  const teams = (L().roster?.[koCat] || []).length;
  if (teams < 4) return nav + empty(
    `ל${catName(koCat)} יש ${teams} קבוצות. פיינל פור דורש ארבע מעפילות (3.9.1).`);

  const S = syncKO(koCat);
  if (!S.ready) return nav + empty('הדירוג עוד לא מספק ארבע קבוצות.');

  // §2.5 — שוויון שנוגע לגבול הפיינל פור (מקומות 4–5) חוסם: התקנון לא מכריע
  // מי הרביעית, וההכרעה חייבת להירשם ידנית לפני שהבראקט נבנה.
  const blocking = S.alerts.filter(a => a.touchesF4);
  const seeding  = S.alerts.filter(a => !a.touchesF4 && a.start <= 4);

  const msgs =
    blocking.map(a => `<div class="sched-msg err">⛔ שוויון מלא בין ${a.size} קבוצות על מקומות
        <b class="num">${a.start}–${a.end}</b> — הוא נוגע לגבול הפיינל פור (4–5). התקנון לא מכריע
        (§2.5), ולכן הבראקט לא נבנה עד שההכרעה תירשם ידנית בעמוד <b>דירוג</b>.</div>`).join('') +
    seeding.map(a => `<div class="sched-msg warn">⚠ שוויון לא מוכרע על מקומות
        <b class="num">${a.start}–${a.end}</b>. כל הארבע מעפילות, אבל סדר השיבוץ (מי מול מי)
        תלוי בהכרעה.</div>`).join('');

  if (blocking.length) return nav + msgs + qualifiersCard(S) + subsLog(S);

  return nav + msgs
       + qualifiersCard(S)
       + choiceCard(S)
       + bracket(S)
       + entryCard(S)
       + subsLog(S);
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
    <span class="sett-desc" style="margin-top:10px">3.9.1 — ארבעת המקומות הראשונים.
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
    <span class="sett-desc">3.9.2 — לקבוצה שסיימה במקום 1 יש זכות לבחור באיזה חצי גמר תשחק.
      היריבה היא מקום 4 בכל מקרה, ולכן הבחירה היא בסלוט בלבד; מקומות 2–3 נכנסים לסלוט השני.
      כרגע: <b>${escH(teamName(S.seeds[0]))}</b> משחקת בחצי גמר ${cur === 1 ? '①' : '②'}.</span>
  </div>`;
}

// ── הבראקט ─────────────────────────────────────────────────────────────────
function bracket(S) {
  const box = key => matchBox(S, key);
  const champ = champBox(S);

  return `<div class="sett-section">
    <div class="sett-section-title">הבראקט</div>
    <div class="bscroll" data-sk="ko-bracket" id="ko-bracket">
      <div class="btree">
        <div class="bround">
          <div class="brnd-title">חצאי גמר</div>
          <div class="brnd-matches">
            <div class="bmatch-wrap">${box('sf0')}</div>
            <div class="bmatch-wrap" style="margin-top:46px">${box('sf1')}</div>
          </div>
        </div>
        <div class="bround">
          <div class="brnd-title">גמר</div>
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

  const ph = key === 'final' ? ['מנצחת חצי ①', 'מנצחת חצי ②']
           : key === 'third' ? ['מפסידה חצי ①', 'מפסידה חצי ②']
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
      ${seed ? `<span class="bsc">מק׳ ${seed}</span>` : ''}
      ${score !== '' ? `<span class="bsc">${score}</span>` : ''}
    </div>`;
  };

  const sets = f.sets === 3 && (m.sets || []).length
    ? `<span class="sett-desc" style="text-align:center;margin-top:4px">${
        m.sets.filter(s => s && s.a != null && s.b != null)
              .map(s => `${s.a}:${s.b}`).join(' · ')}</span>`
    : '';

  return `<div class="bmatch-box">
    <div class="bm-label">${KEYS[key]} · ${escH(fmtText(f))}</div>
    <div class="bmatch">${side(m.a, 0)}${side(m.b, 1)}</div>
    ${sets}
  </div>`;
}

function champBox(S) {
  const d = decide(S.K.final, fmtOf(koCat, 'final'));
  if (!d) return '';
  const third = decide(S.K.third, fmtOf(koCat, 'third'));
  return `<div class="champ-wrap">
    <div class="ci">אלופת ${escH(catName(koCat))}</div>
    <div class="champ-name">${escH(teamName(d.win))}</div>
    <span class="sett-desc" style="margin-top:8px">מקום 2: ${escH(teamName(d.lose))}${
      third ? ` · מקום 3: ${escH(teamName(third.win))}` : ''}</span>
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
    ${KEYS[key]} <span class="muted">· ${escH(fmtText(f))}</span>
    ${d ? `<span class="status-badge badge-approved">הסתיים</span>` : ''}
  </div>`;

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
    pairs: [ { a:fromEnd(3), b:B[2], label:'שלישית מהסוף מול מקום 3' },   // 3.11.3
             { a:fromEnd(4), b:B[3], label:'רביעית מהסוף מול מקום 4' } ], // 3.11.4
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
    return (cur && cur.a === a && cur.b === b) ? cur : { a, b, sa:null, sb:null };
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
  if (!has1 || !has2) return empty('משחקי ההצלבה נגזרים משתי הטבלאות הסופיות של ליגה ראשונה וליגה שנייה.');

  const P = crossPlan();

  if (!P.ok) return `<div class="sched-msg err">⛔ ליגה ראשונה עם ${P.N} קבוצות בלבד${
      P.M < MIN_M ? ` וליגה שנייה עם ${P.M}` : ''} — מנגנון ההצלבה של 3.11 לא ישים
      (דורש N ≥ ${MIN_N} ו-M ≥ ${MIN_M}). המערכת לא מחשבת אוטומטית; נדרשת החלטה.</div>`
      + finalTables(P);

  const games = syncCross(P);
  const f = fmtOf('liga1', 'regular');

  // אזהרת §2.5 רק כששוויון לא מוכרע נוגע למקומות שהמנגנון קורא בהם.
  const hot1 = new Set([P.N, P.N - 1, P.N - 2, P.N - 3]);
  const hot2 = new Set([1, 2, 3, 4, 5]);
  const warn = P.alerts.filter(a => {
    const hot = a.cat === 'liga1' ? hot1 : hot2;
    for (let r = a.start; r <= a.end; r++) if (hot.has(r)) return true;
    return false;
  }).map(a => `<div class="sched-msg warn">⚠ שוויון לא מוכרע ב${escH(catName(a.cat))} על מקומות
      <b class="num">${a.start}–${a.end}</b> — הוא נוגע לגבול העלייה/ירידה. ההכרעה חייבת
      להירשם לפני שההצלבה נקבעת (§2.5).</div>`).join('');

  const auto = `<div class="sett-section">
    <div class="sett-section-title">אוטומטי — בלי משחק</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>קבוצה</th><th>מאיפה</th><th>מקום</th><th>לאן</th></tr></thead>
      <tbody>
        ${P.down.map((r, i) => `<tr>
          <td class="stand-name">${escH(r.row.name)}</td>
          <td>${escH(catName('liga1'))}</td>
          <td class="num">${r.rank} <span class="muted">(${i === 0 ? 'שנייה מהסוף' : 'אחרונה'})</span></td>
          <td><span class="status-badge badge-rejected">⬇ יורדת לליגה שנייה</span></td></tr>`).join('')}
        ${P.up.map(r => `<tr>
          <td class="stand-name">${escH(r.row.name)}</td>
          <td>${escH(catName('liga2'))}</td>
          <td class="num">${r.rank}</td>
          <td><span class="status-badge badge-approved">⬆ עולה לליגה ראשונה</span></td></tr>`).join('')}
      </tbody>
    </table></div>
    <span class="sett-desc" style="margin-top:10px">3.11.1–3.11.2. הספירה מלמטה:
      ב-${P.N} קבוצות בליגה ראשונה, "שתי האחרונות" הן מקומות
      <b class="num">${P.N - 1}</b> ו-<b class="num">${P.N}</b> — המספרים האלה תוצאה של החישוב,
      לא קלט לו (§2.7).</span>
  </div>`;

  const rows = P.pairs.map((p, i) => {
    const g = games[i];
    const dec = decide({ ...g, sets:[] }, f);
    const nameA = escH(p.a.row.name), nameB = escH(p.b.row.name);
    const filled = g.sa != null && g.sb != null;
    const bad = filled && !dec;
    const inp = side => `<input class="text-inp res-inp" type="number" min="0" max="60"
        id="ko-cross-${i}-${side}" value="${(side === 'sa' ? g.sa : g.sb) ?? ''}"
        data-ko="ko.cross" data-i="${i}" data-side="${side}"${RO(1)}/>`;
    return `<div style="margin-bottom:16px">
      <div class="sett-card-title" style="margin-bottom:2px">הצלבה ${i + 1}
        <span class="muted">· ${escH(p.label)} · ${escH(fmtText(f))}</span>
        ${dec ? `<span class="status-badge badge-approved">הסתיים</span>` : ''}</div>
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
  }).join('');

  const play = `<div class="sett-section">
    <div class="sett-section-title">משחקי ההצלבה</div>
    ${rows}
    <span class="sett-desc">3.11.3–3.11.5 — המנצחת בכל הצלבה תשחק בליגה הראשונה, המפסידה בשנייה.
      סה״כ שני משחקים, במועד נפרד אחרי הפיינל פור (3.11.6).</span>
  </div>`;

  return warn + auto + play + nextSeason(P, games, f) + finalTables(P);
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

  const inA = P.A.filter(r => !downIds.has(r.row.id) && !loseTo2.has(r.row.id)).map(r => r.row.name)
    .concat(P.up.map(r => r.row.name), P.B.filter(r => winTo1.has(r.row.id)).map(r => r.row.name));
  const inB = P.A.filter(r => downIds.has(r.row.id) || loseTo2.has(r.row.id)).map(r => r.row.name)
    .concat(P.B.filter(r => !upIds.has(r.row.id) && !winTo1.has(r.row.id)).map(r => r.row.name));

  const col = (title, names) => `<div class="sett-card">
    <div class="sett-card-title">${escH(title)} <span class="muted">(${names.length})</span></div>
    <ol style="margin:0;padding-inline-start:20px;font-size:13px;line-height:1.9">
      ${names.map(n => `<li>${escH(n)}</li>`).join('')}
    </ol></div>`;

  return `<div class="sett-section">
    <div class="sett-section-title">הרכב הליגות לעונה הבאה</div>
    ${done ? '' : `<div class="sched-msg warn">ממתין לתוצאות ההצלבה — ההרכב למטה מניח
      שהמצב הנוכחי נשמר, ויתעדכן ברגע שיוזנו התוצאות.</div>`}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
      ${col(catName('liga1'), inA)}${col(catName('liga2'), inB)}
    </div>
  </div>`;
}

// שתי הטבלאות הסופיות — מוצגות תמיד, וגם כשהסף לא מתקיים (§2.7 מחייב).
function finalTables(P) {
  const tbl = (title, rows) => `<div class="sett-card">
    <div class="sett-card-title">${escH(title)}</div>
    <div class="tscroll"><table class="stbl">
      <thead><tr><th>#</th><th>קבוצה</th><th>נק׳</th><th>הפרש</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="num">${r.rank}</td>
        <td class="stand-name">${escH(r.row.name)}</td>
        <td class="num">${r.row.pts}</td>
        <td class="num">${r.row.diff > 0 ? '+' : ''}${r.row.diff}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  return `<div class="sett-section">
    <div class="sett-section-title">הטבלאות הסופיות</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
      ${tbl(catName('liga1'), P.A)}${tbl(catName('liga2'), P.B)}
    </div>
  </div>`;
}

// ============================================================================
// המסך המלא (שתי הלשוניות) — נקודת החיווט הנוחה ל-league.js
// ============================================================================

export function render(container) {
  const nav = `<div class="court-filter">
    <button class="cf-btn${tab === 'ff' ? ' on' : ''}" data-ko="ko.tab" data-tab="ff">פיינל פור</button>
    <button class="cf-btn${tab === 'cross' ? ' on' : ''}" data-ko="ko.tab" data-tab="cross">משחקי הצלבה</button>
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
