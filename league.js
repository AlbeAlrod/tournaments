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

// ⚠️ צבעים זמניים. §15.1: ארבעת קודי הצבע לרשתות והקוד הוורוד למסך הטעינה
// טרם נשלחו. כל ערך שמסומן PLACEHOLDER מוחלף בשלב 8.
const PLACEHOLDER_NET_COLORS = ['#C0392B', '#1D6FB8', '#158A5B', '#D18B1F'];
const PLACEHOLDER_PINK       = '#F3C6D8';
const PLACEHOLDER_PRIMARY    = '#652d92';
const PLACEHOLDER_SECONDARY  = '#7a3fb0';

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
      primaryColor:   PLACEHOLDER_PRIMARY,    // PLACEHOLDER §15.1
      secondaryColor: PLACEHOLDER_SECONDARY,  // PLACEHOLDER §15.1
      loadingColor:   PLACEHOLDER_PINK,       // PLACEHOLDER §15.1 — החלטה 14
      font: 'Rubik',                          // מלכודת 4: Barlow לטיני בלבד
      sponsorLogos: [],

      // אין Firebase Auth — ההרשאות נאכפות בדפדפן בלבד. ראו SECURITY.md
      // ומלכודת 7: לא לשמור טלפונים בדוק הזה.
      adminPasswordHash: '',
      managerPasswordHash: '',

      nets: PLACEHOLDER_NET_COLORS.map((color, i) => ({
        id: i + 1, name: `רשת ${i + 1}`, color   // PLACEHOLDER §15.1
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
      { id:'liga2', name:'ליגה שנייה',  rr:1, order:3 }
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

function newTeam(catId, name) {
  return {
    id: nextTeamId(catId),
    name: name || '',      // מחרוזת אחת, מוצגת כיחידה (החלטה 8)
    size: 2,               // 2 או 3 (2.1)
    active: true,
    withdrewAfterDay: null // 6.1.1 מול 6.1.2
  };
}

// כל הקבוצות בכל הליגות, לחיפוש לפי מזהה
function findTeam(id) {
  for (const [cat, list] of Object.entries(L.roster)) {
    const t = list.find(x => x.id === id);
    if (t) return { team: t, cat };
  }
  return null;
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
  return {
    meta:         { ...d.meta, ...(data.meta || {}) },
    categories:   data.categories?.length ? data.categories : d.categories,
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
      page === 'teams'    ? renderTeams()
    : page === 'settings' ? renderSettings()
    : page === 'status'   ? renderStatus()
    : renderPlaceholder(target);

  renderSponsorBar();
  focusRestore(f);
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
    <p>העמוד הזה נבנה בשלב ${p.stage} מתוך §14 במפרט. כרגע בנויים שלבים 1–2:
       מודל הנתונים, סנכרון חי, רוסטר, רשתות, ימים והגדרות.</p>
  </div>`;
}

// ============================================================================
// עמוד קבוצות — §14 שלב 2
// ============================================================================

function renderTeams() {
  const cards = L.categories.map(c => {
    const list = L.roster[c.id] || [];
    const rows = list.map((t, i) => `
      <div class="team-row${t.active ? '' : ' inactive'}">
        <span class="team-num">${i + 1}</span>
        <input class="text-inp team-name-inp" id="tn-${escH(t.id)}" value="${escH(t.name)}"
               placeholder="שם הקבוצה" data-act="team.name" data-id="${escH(t.id)}"/>
        <select class="text-inp team-size-sel" data-act="team.size" data-id="${escH(t.id)}">
          <option value="2"${t.size === 2 ? ' selected' : ''}>זוג</option>
          <option value="3"${t.size === 3 ? ' selected' : ''}>שלישייה</option>
        </select>
        <button class="reg-btn" data-act="team.active" data-id="${escH(t.id)}"
                title="${t.active ? 'להוציא מהתחרות' : 'להחזיר לתחרות'}">${t.active ? 'פעילה' : 'פרשה'}</button>
        <button class="team-del" data-act="team.del" data-id="${escH(t.id)}" title="מחיקה">×</button>
        <code class="team-id num">${escH(t.id)}</code>
      </div>`).join('');

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
    ⚠️ ארבעת הקודים הנוכחיים זמניים — §15.1, הקודים האמיתיים טרם נשלחו.
    צבע הטקסט על כל צ׳יפ מחושב אוטומטית כדי להישאר קריא.
  </div>`;

  // ── 4. ימים ──
  const days = (m.days || []).map((d, i) => `
    <div class="cat-item">
      <div class="cat-item-head">
        <input class="text-inp" style="flex:1" value="${escH(d.label)}" data-act="day.label" data-i="${i}"/>
        <label class="toggle-switch" title="${d.published ? 'מפורסם' : 'מוסתר'}">
          <input type="checkbox"${d.published ? ' checked' : ''} data-act="day.published" data-i="${i}"/>
          <span class="toggle-slider"></span>
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
      ⚠️ ארבעת קודי הצבע והשמות הם זמניים. §15.1 — הקודים האמיתיים טרם נשלחו.
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
  'team.name':   el => { const f = findTeam(el.dataset.id); if (f) f.team.name = el.value.trim(); },
  'team.size':   el => { const f = findTeam(el.dataset.id); if (f) f.team.size = +el.value; },
  'team.active': el => { const f = findTeam(el.dataset.id); if (f) f.team.active = !f.team.active; },

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

  // ── סיסמאות ──
  'pw.admin':   el => hashPassword('adminPasswordHash', el),
  'pw.manager': el => hashPassword('managerPasswordHash', el),

  // ── בדיקת סנכרון (dev) ──
  'dev.name': el => { L.meta.name = el.value.trim(); }
};

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
  'team.name', 'team.size', 'cat.name',
  'fmt.to', 'fmt.third', 'fmt.cap',
  'day.label', 'day.beach',
  'sponsor.url', 'sponsor.alt'
]);

function handle(e, kinds) {
  const el = e.target.closest('[data-act]');
  if (!el || !kinds.test(el.tagName)) return;
  const act = el.dataset.act;
  const fn = ACT[act];
  if (!fn) return;
  const skip = fn(el, e) === false || NO_REPAINT.has(act);
  queueSave();
  if (!skip) paint();
}

document.addEventListener('click',  e => {
  const tab = e.target.closest('[data-page]');
  if (tab) { page = tab.dataset.page; paint(); return; }
  handle(e, /^(BUTTON|A)$/);
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

(async function start() {
  // מסך הטעינה ורוד (החלטה 14) — הצבע מגיע מהמודל, כך שהחלפתו בשלב 8
  // היא שינוי נתון ולא שינוי קוד.
  const load = document.getElementById('view-loading');
  load.style.background = PLACEHOLDER_PINK;
  load.style.color = onColor(PLACEHOLDER_PINK);

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
