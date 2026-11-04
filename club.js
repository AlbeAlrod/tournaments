// club.html — club / branch managers and the super-admin, for SECURE tournaments only.
// Sign-in is Firebase Auth (email + password); every write is checked by firestore.rules
// against the custom claims set by the inviteManager Cloud Function.
import { fbApp, db, escH as esc, doc, getDoc, setDoc, updateDoc, serverTimestamp } from './common.js?v=73';
import { collection, getDocs, query, where, getCountFromServer } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';

const auth = getAuth(fbApp);
const inviteManager = httpsCallable(getFunctions(fbApp, 'europe-west1'), 'inviteManager');
const $ = id => document.getElementById(id);
let claims = {}, clubId = '', clubs = [], branches = [];

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
const slug = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tLink = id => new URL(`index.html?t=${encodeURIComponent(id)}`, location.href).href;

// ── Auth ─────────────────────────────────────────────────────
async function login() {
  showErr('lg-err', '');
  try { await signInWithEmailAndPassword(auth, $('lg-email').value.trim(), $('lg-pw').value); }
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
  $('sec-super').classList.toggle('h', claims.role !== 'super');
  if (claims.role === 'super') { await loadSuper(); return; }
  await openClub(claims.club);
});

// ── Super: approvals + clubs ─────────────────────────────────
async function loadSuper() {
  clubs = (await getDocs(collection(db, 'clubs'))).docs.map(d => ({ id: d.id, ...d.data() }));
  $('club-list').innerHTML = clubs.length ? clubs.map(c =>
    `<button class="row-btn" onclick="openClub('${esc(c.id)}')"><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.id)}</span></button>`).join('')
    : '<p class="muted">אין עדיין מועדונים.</p>';
  await loadPending();
  if (clubId) await openClub(clubId); else $('sec-club').classList.add('h');
}

async function loadPending() {
  const snap = await getDocs(query(collection(db, 'tournaments'), where('approval', '==', 'pending')));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('pending-list').innerHTML = rows.length ? rows.map(t => `<div class="card">
      <div><strong>${esc(t.meta?.name)}</strong> <span class="muted">${esc(t.clubId)} · ${esc(t.branchId)} · ${esc(t.meta?.eventDate || '')}</span></div>
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
  const name = $('nc-name').value.trim(), id = slug($('nc-id').value);
  if (!name || !id) return showErr('nc-err', 'נדרשים שם ומזהה באנגלית.');
  if (clubs.some(c => c.id === id)) return showErr('nc-err', 'המזהה תפוס.');
  try {
    await setDoc(doc(db, 'clubs', id), { name, createdAt: serverTimestamp() });
    $('nc-name').value = $('nc-id').value = '';
    showErr('nc-err', '');
    await loadSuper();
  } catch (e) { showErr('nc-err', 'יצירת המועדון נכשלה.'); }
}

// ── Club: branches, tournaments, managers ───────────────────
async function openClub(id) {
  clubId = id;
  const club = (await getDoc(doc(db, 'clubs', id))).data() || {};
  $('club-name').textContent = club.name || id;
  branches = (await getDocs(collection(db, 'clubs', id, 'branches'))).docs.map(d => ({ id: d.id, ...d.data() }));
  const mine = claims.role === 'branch' ? branches.filter(b => b.id === claims.branch) : branches;
  const opts = mine.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  $('nt-branch').innerHTML = opts;
  $('inv-branch').innerHTML = opts;
  $('branch-list').innerHTML = branches.map(b => `<span class="chip">${esc(b.name)}</span>`).join('') || '<span class="muted">אין עדיין סניפים.</span>';
  $('branch-add').classList.toggle('h', claims.role === 'branch');
  $('inv-role-wrap').classList.toggle('h', claims.role !== 'super');
  $('sec-club').classList.remove('h');
  await loadTournaments();
}

async function addBranch() {
  const name = $('nb-name').value.trim(), id = slug($('nb-id').value);
  if (!name || !id) return toast('נדרשים שם ומזהה באנגלית לסניף');
  try {
    await setDoc(doc(db, 'clubs', clubId, 'branches', id), { name });
    $('nb-name').value = $('nb-id').value = '';
    await openClub(clubId);
  } catch (e) { toast('הוספת הסניף נכשלה'); }
}

async function loadTournaments() {
  const filters = [where('clubId', '==', clubId), ...(claims.role === 'branch' ? [where('branchId', '==', claims.branch)] : [])];
  const rows = (await getDocs(query(collection(db, 'tournaments'), ...filters))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.meta?.eventDate || '').localeCompare(a.meta?.eventDate || ''));
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

async function createTournament() {
  const name = $('nt-name').value.trim(), branchId = $('nt-branch').value, date = $('nt-date').value;
  const cats = $('nt-cats').value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!name || !branchId || !date || !cats.length) return showErr('nt-err', 'נדרשים שם, סניף, תאריך ולפחות קטגוריה אחת.');
  const id = `${clubId}-${date}-${Math.random().toString(36).slice(2, 6)}`;
  const approval = claims.role === 'super' ? 'approved' : 'pending';
  try {
    await setDoc(doc(db, 'tournaments', id), {
      secure: true, clubId, branchId, approval, createdBy: auth.currentUser.uid,
      meta: {
        name, eventDate: date, venue: branches.find(b => b.id === branchId)?.name || '',
        price: $('nt-price').value.trim(), paymentLink: $('nt-pay').value.trim(), paymentLinkLabel: '',
        sport: 'footvolley', lang: 'he', phase: 'registration', regOpen: true, showRegistered: true,
        coordinated: true, parallelCategories: true, allPoolsBeforeKO: true,
        primaryColor: '#652d92', secondaryColor: '#7a3fb0', bgColor: '', logoUrl: '',
        groupColors: [], sponsorLogos: [], regNote: '', paymentLink2: '', paymentLink2Label: ''
      },
      categories: cats.map((n, i) => ({ id: 'c' + (i + 1), name: n, cfg: structuredClone(DEF_CAT_CFG) })),
      state: {},
      updatedAt: serverTimestamp()
    });
    for (const f of ['nt-name', 'nt-date', 'nt-price', 'nt-pay']) $(f).value = '';
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
    const msg = `הוזמנת לנהל טורנירים. לקביעת סיסמה: ${data.link}\nאחר כך נכנסים כאן: ${new URL('club.html', location.href).href}`;
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

Object.assign(window, { login, resetPw, logout, openClub, setApproval, createClub, addBranch, createTournament, invite, copyText });
