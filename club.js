// club.html — club / branch managers and the super-admin, for SECURE tournaments only.
// Sign-in is Firebase Auth (email + password); every write is checked by firestore.rules
// against the custom claims set by the inviteManager Cloud Function.
import { fbApp, db, escH as esc, doc, getDoc, setDoc, updateDoc, serverTimestamp, applyTheme, applyBrandFonts } from './common.js?v=76';
import { collection, getDocs, query, where, getCountFromServer } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut, setPersistence, browserSessionPersistence }
  from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';

const auth = getAuth(fbApp);
const inviteManager = httpsCallable(getFunctions(fbApp, 'europe-west1'), 'inviteManager');
const $ = id => document.getElementById(id);
let claims = {}, clubId = '', clubs = [], branches = [], brand = {}, club = {}, pastCats = [];
const logoData = {};   // form prefix → uploaded logo (data URL)

// Club look: brand = { primary, secondary, logo, fonts } on clubs/{id}. New tournaments copy it.
function applyBrand(b = {}) {
  brand = b;
  if (b.primary) applyTheme(b.primary, b.secondary, { hasLogo: !!b.logo, neutralText: b.neutralText });
  for (const id of ['lg-logo', 'top-logo']) {
    $(id).classList.toggle('h', !b.logo);
    if (b.logo) $(id).src = b.logo;
  }
  applyBrandFonts(b.fonts);
}
const brandParam = new URLSearchParams(location.search).get('club');
if (brandParam) getDoc(doc(db, 'clubs', brandParam)).then(s => applyBrand(s.data()?.brand), () => {});

const KO_STAGES = ['pool', 'r16', 'qf', 'sf', 'third', 'final'];
const DEF_CAT_CFG = {
  courts: 4, numGroups: 4, advPerGroup: 2, gameDur: 25, breakDur: 0, startTime: '07:00',
  pointsToWin: 21, sets: 1, pointsThirdSet: 15,
  koRules: Object.fromEntries(KO_STAGES.map(k => [k, { pts: 21, change: 7, dur: 25 }]))
};
const STATUS = { pending: 'ממתין לאישור', approved: 'מאושר', rejected: 'נדחה' };
const ROLE = { super: 'מנהל מערכת', owner: 'בעל מועדון', branch: 'מנהל סניף' };

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('h');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('h'), 3500);
}
const showErr = (id, msg) => { $(id).textContent = msg; $(id).classList.toggle('h', !msg); };
// Ids are made from the Hebrew name (transliterated), so nobody has to type one.
const HE = { א: 'a', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'h', ט: 't', י: 'y', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm',
  נ: 'n', ן: 'n', ס: 's', ע: 'a', פ: 'p', ף: 'p', צ: 'tz', ץ: 'tz', ק: 'k', ר: 'r', ש: 'sh', ת: 't' };
const slug = s => [...s.toLowerCase().trim()].map(c => HE[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const freeId = (base, taken) => { base = base || 'x' + Math.random().toString(36).slice(2, 6); let id = base, n = 2; while (taken(id)) id = `${base}-${n++}`; return id; };
const SPORTS = { footvolley: 'פוצ\'יוולי', volleyball: 'כדורעף חופים' };
const tLink = id => new URL(`index.html?t=${encodeURIComponent(id)}`, location.href).href;

// ── Auth ─────────────────────────────────────────────────────
async function login() {
  showErr('lg-err', '');
  try {
    await setPersistence(auth, browserSessionPersistence);   // signed in until the browser closes
    await signInWithEmailAndPassword(auth, $('lg-email').value.trim(), $('lg-pw').value);
  }
  catch (e) { showErr('lg-err', e.code === 'auth/too-many-requests' ? 'יותר מדי ניסיונות. נסו שוב מאוחר יותר.' : 'מייל או סיסמה שגויים.'); }
}
async function resetPw() {
  const email = $('lg-email').value.trim();
  if (!email) return showErr('lg-err', 'הזינו מייל ואז לחצו שוב.');
  await sendPasswordResetEmail(auth, email).catch(() => {});
  showErr('lg-err', 'אם המייל רשום, נשלח אליו קישור לאיפוס סיסמה.');
}
const logout = () => signOut(auth);

onAuthStateChanged(auth, async u => {
  claims = u ? (await u.getIdTokenResult(true)).claims : {};
  const staff = !!ROLE[claims.role];
  $('screen-login').classList.toggle('h', staff);
  $('screen-app').classList.toggle('h', !staff);
  if (u && !staff) showErr('lg-err', 'לחשבון הזה אין הרשאת ניהול. בקשו הזמנה ממנהל המועדון.');
  if (!staff) return;
  $('who').textContent = `${u.email} · ${ROLE[claims.role]}`;
  const sup = claims.role === 'super';
  $('tabs').classList.toggle('h', !sup);
  $('club-pick-box').classList.toggle('h', !sup);
  $('edit-club-btn').classList.toggle('h', !sup);
  $('invite-box').querySelector('h2').textContent = claims.role === 'branch' ? 'הזמנת מנהל לסניף' : 'הזמנת מנהל למועדון';
  if (!sup) return openClub(claims.club);
  $('nc-form').innerHTML = clubForm('nc');
  await loadSuper();
});

// Two separate areas for the super-admin: the club being managed, and the system (approvals, new clubs).
function showTab(tab) {
  for (const k of ['club', 'system']) {
    $('tab-' + k).classList.toggle('on', k === tab);
    $('tab-' + k).setAttribute('aria-selected', k === tab);
    $('sec-' + k).classList.toggle('h', k !== tab);
  }
}

// ── Club look form (new club / edit club) ────────────────────
function clubForm(p, c = {}) {
  const b = c.brand || {};
  logoData[p] = b.logo || '';
  return `<div class="grid">
    <div><label for="${p}-name">שם המועדון</label><input class="form-input" id="${p}-name" value="${esc(c.name || '')}"/></div>
    <div><label for="${p}-sport">ענף</label><select class="form-input" id="${p}-sport">
      ${Object.entries(SPORTS).map(([k, v]) => `<option value="${k}" ${(c.sport || 'footvolley') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div><label for="${p}-primary">צבע ראשי</label><input class="form-input" id="${p}-primary" type="color" value="${esc(b.primary || '#652d92')}"/></div>
    <div><label for="${p}-secondary">צבע משני</label><input class="form-input" id="${p}-secondary" type="color" value="${esc(b.secondary || '#7a3fb0')}"/></div>
    <div><label>לוגו</label><div class="logo-row">
      <img id="${p}-logo-prev" class="logo-prev${b.logo ? '' : ' h'}" src="${esc(b.logo || '')}" alt=""/>
      <label class="mini" style="margin:0;font-weight:400">${b.logo ? 'החלפת לוגו' : 'העלאת לוגו'}
        <input class="h" id="${p}-logo" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onchange="pickLogo('${p}',this.files[0])"/></label></div></div>
    <div><label for="${p}-fonts">פונטים (Google Fonts)</label><input class="form-input" id="${p}-fonts" dir="ltr" placeholder="Poppins, Heebo" value="${esc((b.fonts || []).join(', '))}"/></div>
  </div>`;
}

// A logo file becomes a small data URL stored on the club (no file hosting needed).
async function pickLogo(p, file) {
  if (!file) return;
  let url;
  if (file.type === 'image/svg+xml') {
    if (file.size > 75000) return toast('קובץ ה-SVG גדול מדי. נסו PNG.');
    url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  } else {
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return toast('לא הצלחנו לקרוא את התמונה');
    const k = Math.min(1, 320 / Math.max(img.width, img.height));
    const cv = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    url = cv.toDataURL('image/png');
    if (url.length > 100000) url = cv.toDataURL('image/webp', 0.85);
    if (url.length > 100000) return toast('התמונה גדולה מדי');
  }
  logoData[p] = url;
  $(p + '-logo-prev').src = url;
  $(p + '-logo-prev').classList.remove('h');
}

function readClubForm(p) {
  const secondary = $(p + '-secondary').value;
  return {
    name: $(p + '-name').value.trim(), sport: $(p + '-sport').value,
    brand: { primary: $(p + '-primary').value, secondary, logo: logoData[p] || '',
      fonts: $(p + '-fonts').value.split(',').map(f => f.trim()).filter(Boolean),
      neutralText: /^#[0-3][0-9a-f][0-3][0-9a-f][0-3][0-9a-f]$/i.test(secondary) }
  };
}

// ── Super: approvals + clubs ─────────────────────────────────
async function loadSuper() {
  clubs = (await getDocs(collection(db, 'clubs'))).docs.map(d => ({ id: d.id, ...d.data() }));
  $('club-pick').innerHTML = clubs.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  await loadPending();
  const want = clubId || (clubs.some(c => c.id === brandParam) ? brandParam : clubs[0]?.id);
  if (want) await openClub(want);
  showTab(clubs.length ? 'club' : 'system');
}

async function loadPending() {
  const snap = await getDocs(query(collection(db, 'tournaments'), where('approval', '==', 'pending')));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const cName = id => clubs.find(c => c.id === id)?.name || id;
  $('pending-count').textContent = rows.length;
  $('pending-count').classList.toggle('h', !rows.length);
  $('pending-list').innerHTML = rows.length ? rows.map(t => `<div class="card">
      <div><strong>${esc(t.meta?.name)}</strong> <span class="muted">${esc(cName(t.clubId))} · ${esc(t.meta?.venue || t.branchId)} · ${esc(t.meta?.eventDate || '')}</span></div>
      <div class="btns">
        <a class="mini" href="${esc(tLink(t.id))}" target="_blank" rel="noopener">צפייה</a>
        <button class="mini ok" onclick="setApproval('${esc(t.id)}','approved')">אישור</button>
        <button class="mini" onclick="setApproval('${esc(t.id)}','rejected')">דחייה</button>
      </div></div>`).join('')
    : '<p class="muted">אין טורנירים שממתינים לאישור.</p>';
}

async function setApproval(id, approval) {
  try {
    await updateDoc(doc(db, 'tournaments', id), { approval, reviewedAt: serverTimestamp() });
    toast(approval === 'approved' ? 'הטורניר אושר ופורסם' : 'הטורניר נדחה');
    await loadPending();
    if (clubId) await loadTournaments();
  } catch (e) { toast('הפעולה נכשלה'); }
}

async function createClub() {
  const c = readClubForm('nc');
  if (!c.name) return showErr('nc-err', 'נדרש שם למועדון.');
  const id = freeId(slug(c.name), x => clubs.some(k => k.id === x));
  try {
    await setDoc(doc(db, 'clubs', id), c);
    showErr('nc-err', '');
    $('nc-form').innerHTML = clubForm('nc');
    clubId = id;
    await loadSuper();
    toast('המועדון נוצר');
  } catch (e) { showErr('nc-err', 'יצירת המועדון נכשלה.'); }
}

function toggleEditClub() {
  const open = $('ec-wrap').classList.toggle('h') === false;
  if (open) $('ec-form').innerHTML = clubForm('ec', club);
}

async function saveClub() {
  const c = readClubForm('ec');
  if (!c.name) return showErr('ec-err', 'נדרש שם למועדון.');
  try {
    await setDoc(doc(db, 'clubs', clubId), c, { merge: true });
    showErr('ec-err', '');
    $('ec-wrap').classList.add('h');
    await loadSuper();
    toast('נשמר');
  } catch (e) { showErr('ec-err', 'השמירה נכשלה.'); }
}

// ── Club: branches, tournaments, managers ───────────────────
async function openClub(id) {
  clubId = id;
  club = (await getDoc(doc(db, 'clubs', id))).data() || {};
  $('club-pick').value = id;
  $('club-name').textContent = club.name || id;
  $('ec-wrap').classList.add('h');
  $('hub-link').href = $('hub-link').textContent = new URL(`tournaments.html?club=${encodeURIComponent(id)}`, location.href).href;
  applyBrand(club.brand);
  branches = (await getDocs(collection(db, 'clubs', id, 'branches'))).docs.map(d => ({ id: d.id, ...d.data() }));
  const mine = claims.role === 'branch' ? branches.filter(b => b.id === claims.branch) : branches;
  const opts = mine.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  $('nt-branch').innerHTML = opts;
  $('inv-branch').innerHTML = opts;
  $('branch-list').innerHTML = branches.map(b => `<span class="chip">${esc(b.name)}</span>`).join('') || '<span class="muted">אין עדיין סניפים.</span>';
  $('branch-add').classList.toggle('h', claims.role === 'branch');
  $('inv-role-wrap').classList.toggle('h', claims.role !== 'super');
  $('nt-note').classList.toggle('h', claims.role === 'super');
  $('sec-club').classList.remove('h');
  await loadTournaments();
  if (!$('nt-cats').children.length) addCatRow();
}

async function addBranch() {
  const name = $('nb-name').value.trim();
  if (!name) return toast('כתבו שם לסניף');
  const id = freeId(slug(name), x => branches.some(b => b.id === x));
  try {
    await setDoc(doc(db, 'clubs', clubId, 'branches', id), { name });
    $('nb-name').value = '';
    await openClub(clubId);
  } catch (e) { toast('הוספת הסניף נכשלה'); }
}

async function loadTournaments() {
  const filters = [where('clubId', '==', clubId), ...(claims.role === 'branch' ? [where('branchId', '==', claims.branch)] : [])];
  const rows = (await getDocs(query(collection(db, 'tournaments'), ...filters))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.meta?.eventDate || '').localeCompare(a.meta?.eventDate || ''));
  pastCats = [...new Set(rows.flatMap(t => (t.categories || []).map(c => c.name?.trim()).filter(Boolean)))];
  $('cat-suggest').innerHTML = pastCats.map(n => `<option value="${esc(n)}"></option>`).join('');
  renderQuickCats();
  const counts = await Promise.all(rows.map(t =>
    getCountFromServer(collection(db, 'tournaments', t.id, 'registrations')).then(c => c.data().count, () => '?')));
  const bName = id => branches.find(b => b.id === id)?.name || id;
  $('t-list').innerHTML = rows.length ? rows.map((t, i) => `<div class="card">
      <div><strong>${esc(t.meta?.name)}</strong>
        <span class="badge ${esc(t.approval)}">${STATUS[t.approval] || ''}</span>
        <div class="muted">${esc(bName(t.branchId))} · ${esc(t.meta?.eventDate || 'ללא תאריך')} · ${counts[i]} הרשמות</div></div>
      <div class="btns">
        <a class="mini ok" href="${esc(tLink(t.id))}" target="_blank" rel="noopener">ניהול</a>
        <button class="mini" onclick="copyText('${esc(tLink(t.id))}')">העתקת קישור</button>
      </div></div>`).join('')
    : '<p class="muted">אין עדיין טורנירים.</p>';
}

// ── New tournament: one row per category (name + max pairs) ──
function addCatRow(name = '') {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML = `<input class="form-input cat-name" list="cat-suggest" placeholder="שם הקטגוריה" aria-label="שם הקטגוריה" value="${esc(name)}" oninput="renderQuickCats()"/>
    <input class="form-input cat-max" type="number" inputmode="numeric" min="0" placeholder="ללא הגבלה" aria-label="מקסימום זוגות"/>
    <button class="mini" aria-label="הסרה" onclick="this.parentElement.remove();renderQuickCats()">✕</button>`;
  $('nt-cats').appendChild(row);
  if (!name) row.querySelector('.cat-name').focus();
  renderQuickCats();
}
const catRows = () => [...$('nt-cats').querySelectorAll('.cat-row')];
function renderQuickCats() {
  const used = new Set(catRows().map(r => r.querySelector('.cat-name').value.trim()));
  const left = pastCats.filter(n => !used.has(n));
  $('cat-quick').innerHTML = left.length ? '<span class="muted">מטורנירים קודמים: </span>' +
    left.map(n => `<button class="chip" onclick="quickCat(this.textContent)">${esc(n)}</button>`).join('') : '';
}
function quickCat(name) {
  const empty = catRows().find(r => !r.querySelector('.cat-name').value.trim());
  if (empty) { empty.querySelector('.cat-name').value = name; renderQuickCats(); } else addCatRow(name);
}

async function createTournament() {
  const name = $('nt-name').value.trim(), branchId = $('nt-branch').value, date = $('nt-date').value;
  const cats = catRows().map(r => ({ name: r.querySelector('.cat-name').value.trim(), max: Math.max(0, parseInt(r.querySelector('.cat-max').value) || 0) }))
    .filter(c => c.name);
  if (!name || !branchId || !date || !cats.length) return showErr('nt-err', 'נדרשים שם, סניף, תאריך ולפחות קטגוריה אחת.');
  const id = `${clubId}-${date}-${Math.random().toString(36).slice(2, 6)}`;
  const approval = claims.role === 'super' ? 'approved' : 'pending';
  try {
    await setDoc(doc(db, 'tournaments', id), {
      secure: true, clubId, branchId, approval, createdBy: auth.currentUser.uid,
      meta: {
        name, eventDate: date, venue: branches.find(b => b.id === branchId)?.name || '',
        price: $('nt-price').value.trim(), paymentLink: $('nt-pay').value.trim(), paymentLinkLabel: '',
        payDeadlineHours: Math.max(1, parseInt($('nt-hours').value) || 24),
        sport: club.sport || 'footvolley', lang: 'he', phase: 'registration', regOpen: true, showRegistered: true,
        coordinated: true, parallelCategories: true, catOrder: 'parallel',
        primaryColor: brand.primary || '#652d92', secondaryColor: brand.secondary || '#7a3fb0', bgColor: '',
        logoUrl: brand.logo || '', fonts: brand.fonts || [], neutralText: !!brand.neutralText,
        groupColors: [], sponsorLogos: [], regNote: '', paymentLink2: '', paymentLink2Label: ''
      },
      categories: cats.map((c, i) => ({ id: 'c' + (i + 1), name: c.name, cfg: { ...structuredClone(DEF_CAT_CFG), maxPairs: c.max } })),
      state: {},
      updatedAt: serverTimestamp()
    });
    for (const f of ['nt-name', 'nt-date', 'nt-price', 'nt-pay']) $(f).value = '';
    $('nt-cats').innerHTML = '';
    addCatRow();
    showErr('nt-err', '');
    toast(approval === 'approved' ? 'הטורניר נוצר ופורסם' : 'הטורניר נוצר ונשלח לאישור');
    await loadTournaments();
    if (claims.role === 'super') await loadPending();
  } catch (e) { showErr('nt-err', 'יצירת הטורניר נכשלה.'); }
}

async function invite() {
  const email = $('inv-email').value.trim();
  const role = claims.role === 'super' ? $('inv-role').value : 'branch';
  const branchId = role === 'branch' ? $('inv-branch').value : undefined;
  showErr('inv-err', '');
  $('inv-out').classList.add('h');
  try {
    const { data } = await inviteManager({ email, role, clubId, branchId });
    const msg = `הוזמנת לנהל טורנירים. לקביעת סיסמה: ${data.link}\nאחר כך נכנסים כאן: ${new URL(`club.html?club=${encodeURIComponent(clubId)}`, location.href).href}`;
    $('inv-link').value = msg;
    $('inv-wa').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
    $('inv-out').classList.remove('h');
    $('inv-email').value = '';
  } catch (e) {
    showErr('inv-err', e.code === 'functions/permission-denied' ? 'אין לך הרשאה להזמין את המנהל הזה.'
      : e.code === 'functions/invalid-argument' ? 'בדקו את כתובת המייל.' : 'ההזמנה נכשלה.');
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('הועתק'), () => toast('ההעתקה נכשלה'));
}

Object.assign(window, { login, resetPw, logout, showTab, openClub, pickLogo, createClub, toggleEditClub, setApproval, saveClub,
  addBranch, addCatRow, renderQuickCats, quickCat, createTournament, invite, copyText });
