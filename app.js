import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, addDoc, getDocs, updateDoc, deleteDoc, query, orderBy, FieldPath, runTransaction, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { pickImage, attachDropZone } from "./uploader.js?v=73";
import { t, initLang, setLang, getLang, applyStatic, fmtDate, tRound, tSlot } from './i18n.js?v=73';
// Same Firebase config as below, so common.js's initializeApp returns this app (no duplicate).
import { onColor, applyBrandFonts } from './common.js?v=76';

// ============ FIREBASE ============
const firebaseConfig = {
  apiKey: "AIzaSyA-rPlg0Oau16QcTjD20hDfkyveRSrD8I0",
  authDomain: "tournaments-33619.firebaseapp.com",
  projectId: "tournaments-33619",
  storageBucket: "tournaments-33619.firebasestorage.app",
  messagingSenderId: "409384565600",
  appId: "1:409384565600:web:61bd55676343d6035abc05"
};
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);

// Secure tournaments (data.secure === true): Firebase Auth + Cloud Functions, loaded on demand
// so legacy tournaments do not pay for them. See SECURITY.md.
let secure = false, tAccess = {};
const authMod = () => import('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js');
async function callFn(name, data) {
  const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js');
  return (await httpsCallable(getFunctions(fbApp, 'europe-west1'), name)(data)).data;
}

// ============ URL PARAM ============
const tId = new URLSearchParams(location.search).get('t');

// ============ STATE ============
const DEF_PRIMARY = '#652d92';
let meta = { name:'', logoUrl:'', primaryColor:DEF_PRIMARY, secondaryColor:'#7a3fb0',
  paymentLink:'', paymentLinkLabel:'', paymentLink2:'', paymentLink2Label:'',
  regNote:'', sponsorLogos: [],
  eventDate:'', venue:'', price:'',   // optional tournament info card (Register + Schedule)
  groupColors: [],   // [gi0,gi1,gi2,gi3] — empty = primary
  bgColor: '',       // override body background — empty = auto from primary
  lang: 'he',
  phase:'registration', regOpen:true, showRegistered:true };
let categories = [];   // [{id, name, cfg}]
let state = {};        // {[catId]: {roster:[], groups:[], sched:[], ko:[]}}
let registrations = [];// [{id, p1, p2, phone, category, status, paid, createdAt}]
let lastBuild = null;  // {at, phase, breaks, state} — doc field, one backup slot before each build

let adminLevel = 0;    // 0=view  1=admin(scores in tournament)  2=manager(full in reg + scores)
let admin = false;
let superAdmin = false;
let loginRole = 'admin';

let activeCat = null;  // selected category id for tournament views
let regFilter = 'all'; // pending|approved|rejected|all
let regPaidFilter = 'all'; // all|paid|unpaid
let regSearch = '';
let schedFilter = [];
let activeCourt = 'all';
let applyingRemote = false;
let firebaseReady = false;

let TREF = null;
let REGS_REF = null;
let PLAYERS_REF = null;
let playerDB = []; // [{name, phone}]

// ============ HTML ESCAPE ============
const escH = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fsi = s => '⁨' + s + '⁩';

// ============ SHA-256 ============
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ============ DISPLAY NAME — removes "ו" connector between partner names ============
// "תום ומוריאל" → "תום מוריאל"  |  "מרג' ואילי" → "מרג' אילי"
const dn = s => {
  if (!s || s.startsWith('Winner') || /^[A-Z]\d+$/.test(s)) return s;
  // Registered pairs are always "p1 / p2" — a "ו" there is part of a real name
  // (e.g. "ורד"), so only strip the connector in slash-less legacy names.
  if (s.includes('/')) return s;
  return s.replace(/\sו([^\s])/g, ' $1');
};
const dnH = s => `<bdi dir="auto">${escH(dn(s))}</bdi>`;

// ============ KO SCORING RULES (per round position from end) ============
const DEF_KO_RULES = {
  pool:   { pts: 15, change: 5 },
  r16:    { pts: 18, change: 6 },
  qf:     { pts: 18, change: 5 },
  sf:     { pts: 18, change: 5 },
  final:  { pts: 21, change: 7 },
  third:  { pts: 15, change: 6 },
};

function getRuleForGame(catId, g, isKO) {
  const cat = categories.find(c=>c.id===catId);
  const rules = { ...DEF_KO_RULES, ...(cat?.cfg?.koRules||{}) };
  if (!isKO) {
    if (g.gi === -1) return rules.third;
    return rules.pool;
  }
  const cs = state[catId];
  if (!cs?.ko?.length) return rules.pool;
  const fromEnd = cs.ko.length - 1 - (g.ri ?? 0);
  if (fromEnd === 0) return rules.final;
  if (fromEnd === 1) return rules.sf;
  if (fromEnd === 2) return rules.qf;
  return rules.r16;
}

// ============ DEFAULT CATEGORY CONFIG ============
const DEF_CAT_CFG = {
  courts: 4, gameDur: 25, breakDur: 0, numGroups: 4, advPerGroup: 2,
  pointsToWin: 21, sets: 1, pointsThirdSet: 15, startTime: '07:00',
  koRules: {
    pool: { pts: 21, change: 7, dur: 25 }, r16: { pts: 21, change: 7, dur: 25 },
    qf: { pts: 21, change: 7, dur: 25 }, sf: { pts: 21, change: 7, dur: 25 },
    third: { pts: 21, change: 7, dur: 25 }, final: { pts: 21, change: 7, dur: 25 },
  }
};

// ============ SYNC ============
let syncOk = true, lastSync = null;
function setSyncStatus(ok = syncOk) {
  syncOk = ok;
  const el = document.getElementById('sync-indicator'), st = document.getElementById('sync-status');
  if (!el) return;
  const off = !ok || !navigator.onLine, n = unsavedGames.size;
  el.className = 'sync-dot ' + (off ? 'sync-offline' : n ? 'sync-pending' : 'sync-ok');
  if (!st) return;
  st.textContent = n ? t('sync.unsaved', { n }) : off && admin ? t('sync.offline')
    : lastSync ? t('sync.updated', { time: lastSync.toTimeString().slice(0, 5) }) : '';
  st.classList.toggle('offline', off);
}

// ============ FIRESTORE HELPERS ============
function koToFB(ko) {
  const obj = {};
  ko.forEach((round, ri) => { obj[`r${ri}`] = round; });
  return obj;
}
function koFromFB(obj) {
  if (!obj) return [];
  return Object.keys(obj).sort((a,b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).map(k => obj[k]);
}
function catStateToFB(cs) {
  return { ...cs, roster: cs.roster||[], groups: cs.groups||[], sched: cs.sched||[], ko: koToFB(cs.ko||[]) };
}
function catStateFromFB(data) {
  return {
    ...data,
    roster: data.roster||[],
    groups: data.groups||[],
    sched:  data.sched||[],
    ko:     koFromFB(data.ko)
  };
}

const emptyCat = () => ({ roster:[], groups:[], sched:[], ko:[] });

// Structural edit of one or more categories: read the server copy in a transaction,
// let fn change it, write state.<cid> back whole (replace, so no ghost ko.rN survives).
// While fn runs, state[cid] IS the fresh copy (so scheduler helpers work on it); the
// first one is also fn's argument. fn returns false to abort, or an object of extra
// top-level fields to write in the same transaction ({'meta.phase': 'built'}).
// fn may run more than once (transaction retry): no side effects outside state.
async function commitState(cids, fn) {
  if (!firebaseReady || !TREF) return false;
  const ids = [].concat(cids);
  let fresh = null;
  try {
    const ok = await runTransaction(db, async tx => {
      const remote = (await tx.get(TREF)).data()?.state || {};
      const mine = {};
      ids.forEach(id => { mine[id] = state[id] || emptyCat(); });
      fresh = Object.fromEntries(ids.map(id =>
        [id, catStateFromFB(structuredClone(remote[id] || catStateToFB(mine[id])))]));
      let extra;
      Object.assign(state, fresh);
      try { extra = fn(fresh[ids[0]]); ids.forEach(id => { fresh[id] = state[id]; }); } finally { Object.assign(state, mine); }
      if (extra === false) return false;
      const args = ids.flatMap(id => [new FieldPath('state', id), catStateToFB(fresh[id])]);
      if (extra && typeof extra === 'object') Object.entries(extra).forEach(([k, v]) => args.push(k, v));
      tx.update(TREF, ...args, 'updatedAt', serverTimestamp());
      return true;
    });
    if (!ok) return false;
    Object.assign(state, fresh);
    applyUnsaved();
    setSyncStatus(true);
    return true;
  } catch(e) {
    console.error('Commit error', e);
    setSyncStatus(false);
    toast(t('errors.saveFailed'));
    return false;
  }
}

async function pushDoc(...args) {
  if (!firebaseReady || !TREF) return false;
  try {
    await updateDoc(TREF, ...args, 'updatedAt', serverTimestamp());
    setSyncStatus(true);
    return true;
  } catch(e) { console.error('Push error', e); setSyncStatus(false); return false; }
}
// Only the given meta keys are written — never the whole meta (password hashes,
// phase, expiry stay as the server has them).
const pushMeta = (...keys) => pushDoc(...keys.flatMap(k => [new FieldPath('meta', k), meta[k] ?? deleteField()]));
const pushCategories = () => pushDoc('categories', categories);

// ============ LOAD TOURNAMENT ============
async function loadTournament() {
  if (!tId) {
    document.getElementById('view-loading').classList.add('h');
    document.getElementById('view-none').classList.remove('h');
    return false;
  }
  TREF = doc(db, 'tournaments', tId);
  REGS_REF = collection(db, 'tournaments', tId, 'registrations');

  let snap;
  try { snap = await getDoc(TREF); }
  catch(e) {
    console.error('Load error', e);
    const p = document.querySelector('#view-loading p');
    if (p) {
      p.textContent = t('sync.loadFailed');
      const b = document.createElement('button');
      b.className = 'add-cat-btn'; b.textContent = t('sync.retry');
      b.onclick = () => location.reload();
      p.after(b);
    }
    window.addEventListener('online', () => location.reload(), { once: true });
    return false;
  }
  lastSync = new Date();
  if (!snap.exists()) {
    // Unknown id (typo / deleted): never create a doc from a public link —
    // tournaments are created in admin.html. Show a friendly not-found view.
    document.getElementById('view-loading').classList.add('h');
    document.getElementById('view-notfound')?.classList.remove('h');
    return false;
  } else {
    const data = snap.data();
    if (data.meta) meta = { ...meta, ...data.meta };
    secure = data.secure === true;
    tAccess = { club: data.clubId, branch: data.branchId };
    // Loading screen stays neutral white (styled in styles.css #view-loading)
    // Expiry check — show expired page and stop loading
    if (meta.expiresAt) {
      const expMs = meta.expiresAt.seconds
        ? meta.expiresAt.seconds * 1000
        : (typeof meta.expiresAt.toMillis === 'function' ? meta.expiresAt.toMillis() : 0);
      if (Date.now() > expMs) {
        document.getElementById('view-loading').classList.add('h');
        document.getElementById('view-expired').classList.remove('h');
        return false;
      }
    }
    if (data.categories) categories = data.categories;
    lastBuild = data.lastBuild || null;
    if (data.state) {
      Object.entries(data.state).forEach(([cid, cs]) => {
        state[cid] = catStateFromFB(cs);
      });
    }
  }

  // Ensure all categories have state
  categories.forEach(cat => {
    if (!state[cat.id]) state[cat.id] = { roster:[], groups:[], sched:[], ko:[] };
  });

  if (secure) watchSecureAuth();
  // Registrations: live listener (Participants / my-registration status update by themselves)
  // Registrations hold phone numbers: viewers only need them before the tournament starts.
  if (meta.phase !== 'tournament') subscribeRegistrations();

  // Live listener
  // Our own pending writes echo back first (hasPendingWrites): skip those; the
  // server ack follows as a metadata change and carries anything others wrote meanwhile.
  onSnapshot(TREF, { includeMetadataChanges: true }, snap => {
    if (!snap.exists() || applyingRemote || snap.metadata.hasPendingWrites) return;
    applyingRemote = true;
    const data = snap.data();
    if (data.meta) meta = { ...meta, ...data.meta };
    if (data.categories) categories = data.categories;
    lastBuild = data.lastBuild || null;
    if (data.state) {
      Object.entries(data.state).forEach(([cid, cs]) => { state[cid] = catStateFromFB(cs); });
      applyUnsaved();
    }
    categories.forEach(cat => {
      if (!state[cat.id]) state[cat.id] = { roster:[], groups:[], sched:[], ko:[] };
    });
    applyingRemote = false;
    if (!snap.metadata.fromCache) lastSync = new Date();
    // Remote update: refresh header/theme/phase, then only the page on screen
    // (renderAll rebuilt every page on every score from every phone).
    const _f = _focusSnapshot();
    renderChrome();
    rerender();
    _focusRestore(_f);
    setSyncStatus(true);
  }, e => { console.error('Tournament listener', e); setSyncStatus(false); });

  return true;
}

const regTime = r => r.createdAt?.seconds ?? 9e15;   // pending server timestamp → last
let regsLoaded = false, regsSub = false;
// Resolves after the first snapshot so boot renders with data. No orderBy in the
// query: docs whose createdAt is still pending would be dropped by it; sort here.
function subscribeRegistrations() {
  if (!REGS_REF || regsSub) return Promise.resolve();
  regsSub = true;
  return new Promise(resolve => {
    let first = true;
    const done = () => { if (first) { first = false; resolve(); } };
    onSnapshot(REGS_REF, snap => {
      registrations = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }), ...contacts[d.id] }))
        .sort((a, b) => regTime(a) - regTime(b));
      regsLoaded = true;
      loadContacts();
      done();
      const active = ['register','participants','registrations']
        .find(p => document.getElementById('page-'+p)?.classList.contains('on'));
      if (active === 'register')      renderRegisterPage();
      if (active === 'participants')  renderParticipants();
      if (active === 'registrations') renderRegistrations();
    }, e => { console.error('Registrations listener', e); done(); });
  });
}

// Secure tournaments keep phone + email in registrations/{id}/private/contact (managers only).
const contacts = {};
async function loadContacts() {
  if (!secure || !admin) return;
  const miss = registrations.filter(r => !contacts[r.id]);
  if (!miss.length) return;
  await Promise.all(miss.map(r => getDoc(doc(db, 'tournaments', tId, 'registrations', r.id, 'private', 'contact'))
    .then(s => { contacts[r.id] = s.data() || {}; }, () => {})));
  registrations.forEach(r => Object.assign(r, contacts[r.id]));
  if (document.getElementById('page-registrations')?.classList.contains('on')) renderRegistrations();
}

async function loadRegistrations() {
  if (!REGS_REF) return;
  try {
    const snap = await getDocs(query(REGS_REF, orderBy('createdAt', 'asc')));
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data(), ...contacts[d.id] }));
  } catch(e) {
    const snap = await getDocs(REGS_REF);
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data(), ...contacts[d.id] }));
  }
  loadContacts();
}

// ============ THEME — dual free color picker ============
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3),16),
    parseInt(hex.slice(3,5),16),
    parseInt(hex.slice(5,7),16)
  ];
}

function hexToHsl(hex) {
  let [r,g,b] = hexToRgb(hex).map(v=>v/255);
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  const l=(max+min)/2;
  let h=0, s=0;
  if (max!==min) {
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h=((g-b)/d+(g<b?6:0))/6; break;
      case g: h=((b-r)/d+2)/6; break;
      case b: h=((r-g)/d+4)/6; break;
    }
  }
  return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
}

function hslToHex(h,s,l) {
  s=Math.max(0,Math.min(100,s)); l=Math.max(0,Math.min(100,l));
  const sd=s/100, ld=l/100;
  let r,g,b;
  if (s===0) { r=g=b=ld; } else {
    const hue2rgb=(p,q,t)=>{
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6)return p+(q-p)*6*t;
      if(t<1/2)return q;
      if(t<2/3)return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q=ld<0.5?ld*(1+sd):ld+sd-ld*sd, p=2*ld-q;
    r=hue2rgb(p,q,h/360+1/3);
    g=hue2rgb(p,q,h/360);
    b=hue2rgb(p,q,h/360-1/3);
  }
  return '#'+[r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

// WCAG relative luminance
function luminance(hex) {
  return hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  }).reduce((sum,v,i) => sum + v * [0.2126,0.7152,0.0722][i], 0);
}

// Contrast ratio (WCAG 2.1)
function contrast(hex1, hex2) {
  const l1=luminance(hex1), l2=luminance(hex2);
  return (Math.max(l1,l2)+0.05) / (Math.min(l1,l2)+0.05);
}

// Adjust lightness until contrast vs bg meets ratio (min 4.5 = WCAG AA)
function readable(candidate, bg, minRatio=4.5) {
  if (contrast(candidate, bg) >= minRatio) return candidate;
  const [h,s] = hexToHsl(candidate);
  const bgDark = luminance(bg) < 0.5; // dark bg → lighten; light bg → darken
  for (let step=1; step<=20; step++) {
    const l = bgDark ? Math.min(100, 50+step*3) : Math.max(0, 50-step*3);
    const c = hslToHex(h, s, l);
    if (contrast(c, bg) >= minRatio) return c;
  }
  return bgDark ? '#FFFFFF' : '#000000';
}

function applyTheme(primary, secondary) {
  primary   = primary   || DEF_PRIMARY;
  secondary = secondary || primary;

  const [r1,g1,b1] = hexToRgb(primary);
  const [h1,s1,l1] = hexToHsl(primary);
  const [h2,s2,l2] = hexToHsl(secondary);

  // ── Backgrounds: barely-there tint — feels white, reads as brand ──
  const bg   = hslToHex(h1, Math.min(s1 * 0.07, 6),  98);
  const bg3  = hslToHex(h1, Math.min(s1 * 0.13, 11), 95);
  const surf = hslToHex(h1, Math.min(s1 * 0.22, 18), 91);

  // ── Text: deep tones grounded in primary hue, forced WCAG contrast ──
  const tint = meta.neutralText ? 0 : 1;   // brands with black/white text (e.g. Mentor)
  const rawText  = hslToHex(h1, Math.min(s1 * 0.30, 28) * tint, 10);
  const rawText2 = hslToHex(h1, Math.min(s1 * 0.50, 44) * tint, 22);
  const rawText3 = hslToHex(h1, Math.min(s1 * 0.60, 54) * tint, 42);
  const text  = readable(rawText,  bg, 7.0);
  const text2 = readable(rawText2, bg, 5.0);
  const text3 = readable(rawText3, bg, 4.5);

  // ── primary3: nav / tab labels — readable on nav bg ──
  const rawP3 = hslToHex(h2, Math.min(s2 * 0.80, 70), Math.min(l2, 46));
  const primary3 = readable(rawP3, bg3, 4.5);

  // ── on-primary: WCAG text for primary-bg buttons / headers ──
  const onPrimaryText = onColor(primary);
  const lum = luminance(primary);
  const shadowStr = onPrimaryText === '#FFFFFF'
    ? Math.max(0, Math.min(0.55, (lum - 0.04) * 1.4))
    : 0;
  const onPrimaryShadow = shadowStr > 0.04
    ? `0 1px 2px rgba(0,0,0,${shadowStr.toFixed(2)}), 0 0 3px rgba(0,0,0,${(shadowStr * 0.3).toFixed(2)})`
    : 'none';

  const [rb3,gb3,bb3] = hexToRgb(bg3);

  // ── Readable variants: slight darkening only when truly needed (ratio 3.5) ──
  const primaryText   = tint ? readable(primary, '#FFFFFF', 3.5) : text;
  const secondaryText = readable(secondary, '#FFFFFF', 3.5);

  const vars = {
    '--primary':            primary,
    '--primary2':           secondary,
    '--primary3':           primary3,
    '--primary-text':       primaryText,
    '--secondary-text':     secondaryText,
    '--bg':                 bg,
    '--bg2':                '#FFFFFF',
    '--bg3':                bg3,
    '--surface':            surf,
    '--border':             `rgba(${r1},${g1},${b1},0.09)`,
    '--border2':            `rgba(${r1},${g1},${b1},0.20)`,
    '--text':               text,
    '--text2':              text2,
    '--text3':              text3,
    '--on-primary':         onPrimaryText,
    '--on-primary-shadow':  onPrimaryShadow,
    '--header-bg':          'rgba(255,255,255,0.94)',
    '--nav-bg':             `rgba(${rb3},${gb3},${bb3},0.97)`,
    '--modebar-bg':         `rgba(${r1},${g1},${b1},0.05)`,
    '--modebar-admin-bg':   `rgba(${r1},${g1},${b1},0.08)`,
  };

  const style = document.getElementById('theme-style') || (() => {
    const s=document.createElement('style'); s.id='theme-style'; document.head.appendChild(s); return s;
  })();
  style.textContent = `:root{${Object.entries(vars).map(([k,v])=>`${k}:${v};`).join('')}}`;
  // Apply custom background override if set
  document.body.style.backgroundColor = meta.bgColor || '';
  applyBrandFonts(meta.fonts);

  const lm = document.getElementById('logo-mark');
  // With a real logo image, don't tint the chip — a dark logo would vanish on a dark primary.
  if (lm) {
    if (meta.logoUrl) { lm.style.background='transparent'; lm.style.boxShadow='none'; lm.style.width='auto'; lm.style.overflow='visible'; }
    else { lm.style.background=primary; lm.style.boxShadow=''; lm.style.width=''; lm.style.overflow=''; }
  }
}

// ============ AUTH ============
function adminClick() {
  if (admin) {
    adminLevel = 0; admin = false; superAdmin = false;
    try { sessionStorage.removeItem(AUTH_KEY()); } catch(_) {}
    if (secure) authMod().then(m => m.signOut(m.getAuth(fbApp)));
    refreshAdmin(); rerender(); return;
  }
  loginRole = 'admin';
  updateRoleButtons();
  document.getElementById('pw-email-row').classList.toggle('h', !secure);
  document.getElementById('pw-modal').classList.remove('h');
  setTimeout(() => document.getElementById('pw-inp').focus(), 80);
}

function selectLoginRole(role) {
  loginRole = role;
  updateRoleButtons();
  document.getElementById('pw-inp').focus();
}

function updateRoleButtons() {
  ['admin','master'].forEach(role => {
    const el = document.getElementById('role-btn-' + role);
    el?.classList.toggle('on', loginRole === role);
    el?.setAttribute('aria-pressed', loginRole === role);
  });
  const hint = document.getElementById('role-hint');
  if (hint) hint.textContent = t(loginRole === 'master' ? 'admin.roleMasterHint' : 'admin.roleAdminHint');
}

async function tryLogin() {
  if (secure) return trySecureLogin();
  const val      = document.getElementById('pw-inp').value.trim();
  const field    = loginRole === 'master' ? 'masterPassword' : 'adminPassword';
  const expected = meta[field];
  if (!val || !expected) {
    document.getElementById('pw-err').classList.remove('h');
    document.getElementById('pw-inp').value = '';
    document.getElementById('pw-inp').focus();
    return;
  }
  const hashed = await sha256(val);
  const isHash  = expected.length === 64 && /^[0-9a-f]+$/.test(expected);
  const match   = isHash ? hashed === expected : val === expected;
  if (match) {
    // Auto-migrate plain-text → hash
    if (!isHash) {
      try {
        await updateDoc(doc(db,'tournaments',tId),{[`meta.${field}`]: hashed});
        meta[field] = hashed;
      } catch(_) {}
    }
    setRole(loginRole);
    try { sessionStorage.setItem(AUTH_KEY(), JSON.stringify({ role: loginRole, h: hashed })); } catch(_) {}
    closeLogin(); refreshAdmin(); rerender();
    if (meta.phase === 'registration' && document.getElementById('page-register')?.classList.contains('on')) goPage('registrations');
  } else {
    document.getElementById('pw-err').classList.remove('h');
    document.getElementById('pw-inp').value = '';
    document.getElementById('pw-inp').focus();
  }
}

// Club staff (club owner, branch manager, super) manage as master; a tournament-password
// token manages only its own tournament, in the role it was issued for.
const securePerm = c => c.tid === tId ? c.trole
  : c.role === 'super' || (c.club && c.club === tAccess.club && (c.role === 'owner' || (c.role === 'branch' && c.branch === tAccess.branch))) ? 'master'
  : null;

function applySecureRole(role) {
  if (!role || (admin && adminLevel === (role === 'master' ? 2 : 1))) return;
  setRole(role); loadContacts();
  if (firebaseReady) { refreshAdmin(); rerender(); }   // before boot, renderAll picks the role up
}

async function watchSecureAuth() {
  const { getAuth, onAuthStateChanged } = await authMod();
  onAuthStateChanged(getAuth(fbApp), async u => {
    if (u) applySecureRole(securePerm((await u.getIdTokenResult()).claims));
  });
}

function loginFailed(key) {
  const err = document.getElementById('pw-err');
  err.textContent = t(key);
  err.classList.remove('h');
  document.getElementById('pw-inp').value = '';
  document.getElementById('pw-inp').focus();
}

async function trySecureLogin() {
  const pw = document.getElementById('pw-inp').value.trim();
  const email = document.getElementById('pw-email').value.trim();
  if (!pw) return loginFailed('admin.pwWrong');
  try {
    const { getAuth, signInWithCustomToken, signInWithEmailAndPassword } = await authMod();
    const auth = getAuth(fbApp);
    if (email) await signInWithEmailAndPassword(auth, email, pw);
    else await signInWithCustomToken(auth, (await callFn('tournamentLogin', { tId, role: loginRole, password: pw })).token);
    const role = securePerm((await auth.currentUser.getIdTokenResult()).claims);
    if (!role) return loginFailed('admin.noAccess');
    closeLogin();
    applySecureRole(role);
    if (meta.phase === 'registration' && document.getElementById('page-register')?.classList.contains('on')) goPage('registrations');
  } catch(e) {
    loginFailed(e.code === 'functions/resource-exhausted' || e.code === 'auth/too-many-requests' ? 'admin.tooMany' : 'admin.pwWrong');
  }
}

function setRole(role) {
  adminLevel = role === 'master' ? 2 : 1;
  admin      = true;
  superAdmin = adminLevel === 2;
  subscribeRegistrations();
}

// Login survives reloads for this browser tab (sessionStorage, per tournament).
// Stores the password hash and re-checks it, so a changed password logs out.
const AUTH_KEY = () => 'luz.auth.' + tId;
async function restoreLogin() {
  if (secure) return;   // Firebase Auth keeps the session; watchSecureAuth restores the role
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(AUTH_KEY()) || 'null'); } catch(_) {}
  if (!s || !['admin','master'].includes(s.role)) return;
  const expected = meta[s.role === 'master' ? 'masterPassword' : 'adminPassword'];
  if (!expected) return;
  const isHash = expected.length === 64 && /^[0-9a-f]+$/.test(expected);
  if (s.h === (isHash ? expected : await sha256(expected))) setRole(s.role);
  else try { sessionStorage.removeItem(AUTH_KEY()); } catch(_) {}
}

function closeLogin() {
  document.getElementById('pw-modal').classList.add('h');
  document.getElementById('pw-inp').value = '';
  document.getElementById('pw-email').value = '';
  document.getElementById('pw-err').textContent = t('admin.pwWrong');
  document.getElementById('pw-err').classList.add('h');
}

function refreshAdmin() {
  const regManager   = admin && meta.phase === 'registration';
  const builtManager = admin && meta.phase === 'built';
  document.body.classList.toggle('admin-mode', regManager || builtManager);
  document.body.classList.toggle('master-mode', adminLevel === 2);

  const txt  = document.getElementById('adm-txt');
  const btn  = document.getElementById('abtn');
  const bar  = document.getElementById('mode-bar');
  const mtxt = document.getElementById('mode-text');
  if (txt) txt.textContent = t(adminLevel===2 ? 'admin.btnMasterOn' : adminLevel===1 ? 'admin.btnAdminOn' : 'admin.btn');
  if (btn) btn.classList.toggle('on', admin);
  if (bar) bar.className = 'mode-bar ' + (admin ? 'mode-admin' : 'mode-view');
  const adminBar = document.getElementById('admin-bar');
  if (adminBar) { adminBar.classList.toggle('mode-admin', admin); adminBar.style.padding = admin ? '' : '2px 16px'; }
  if (mtxt) {
    if (!admin) mtxt.textContent = t('admin.modeView');
    else if (meta.phase==='registration') mtxt.textContent = t(adminLevel===2 ? 'admin.modeMasterReg' : 'admin.modeAdminReg');
    else if (meta.phase==='built') mtxt.textContent = t(adminLevel===2 ? 'admin.modeMasterBuilt' : 'admin.modeAdminBuilt');
    else mtxt.textContent = t(adminLevel===2 ? 'admin.modeMasterScores' : 'admin.modeScores');
  }
  // Register tab stays visible to admins too (preview of the public form)
  const regTab = document.getElementById('tab-register');
  if (regTab) regTab.classList.remove('h');
  document.getElementById('tab-registrations')?.classList.toggle('h', !admin);
  const settingsTab = document.getElementById('tab-settings');
  if (settingsTab) settingsTab.classList.toggle('h', !superAdmin);
  // Auto-navigate away from pages that don't belong in current phase
  if (admin && meta.phase === 'tournament' && document.getElementById('page-build')?.classList.contains('on')) goPage('standings');
  updateNavFade();
}

// ── Start Tournament ────────────────────────────────────────
function openStartModal() {
  document.getElementById('start-modal').classList.remove('h');
}
function closeStartModal() {
  document.getElementById('start-modal').classList.add('h');
}
async function confirmStartTournament() {
  closeStartModal();
  if (!categories.length) return;
  meta.phase = 'tournament';
  await pushMeta('phase');
  document.body.classList.remove('phase-registration');
  document.body.classList.add('phase-tournament');
  refreshAdmin();
  renderAll();
  goPage('schedule');
}

// ============ REGISTRATION ============
// --- pure helpers (no DOM) ---
const NAME_MAX = 30;
const cleanName = s => String(s||'').replace(/\s+/g, ' ').trim();
// Israeli mobile: 05XXXXXXXX, +9725XXXXXXXX or 009725XXXXXXXX → local form "05XXXXXXXX".
// Any other number given as + (or 00) and 8–15 digits → "+<digits>". Anything but digits
// and + is ignored. Returns '' when invalid.
function normPhone(raw) {
  let d = String(raw||'').replace(/[^\d+]/g, '').replace(/^00/, '+');
  if (/^\+?9725\d{8}$/.test(d)) d = '0' + d.replace(/^\+?972/, '');
  if (/^05\d{8}$/.test(d)) return d;
  return /^\+\d{8,15}$/.test(d) ? d : '';
}
// Both players are required (pairs only); this is the single place that rule lives.
// Returns a message function (re-translated on language switch) or null.
function nameError(n, whoKey) {
  const who = () => t(whoKey);
  if (!n) return () => t('errors.nameRequired', { who: who() });
  if (n.length > NAME_MAX) return () => t('errors.nameTooLong', { who: who(), max: NAME_MAX });
  if (n.includes('/')) return () => t('errors.nameSlash', { who: who() });
  return null;
}
const pairKey = (a, b) => [normName(a), normName(b)].sort().join('|');
// Existing registration that clashes with this one (same pair or same phone, same category).
function findDuplicateReg(p1, p2, phone, catId) {
  const key = pairKey(p1, p2);
  return registrations.find(r => r.category === catId && r.status !== 'rejected' && (
    pairKey(r.p1, r.p2) === key || (phone && normPhone(r.phone) === phone)));
}
const statusTxt = st => t('admin.status.' + st);
const regAccepting = () => !!meta.regOpen && meta.phase === 'registration';

// "My registrations" — every pair registered from this browser, per tournament.
// Older builds stored one {regId} under luz.myReg.<tId>; it is folded into the list.
const MYREG_KEY  = () => 'luz.myReg.' + tId;
const MYREGS_KEY = () => 'luz.myRegs.' + tId;
function getMyRegs() {
  try {
    const ids = JSON.parse(localStorage.getItem(MYREGS_KEY()) || '[]');
    const old = JSON.parse(localStorage.getItem(MYREG_KEY()) || 'null');
    const list = Array.isArray(ids) ? ids : [];
    if (old?.regId && !list.includes(old.regId)) list.push(old.regId);
    return list;
  } catch(_) { return []; }
}
function setMyRegs(ids) {
  try { localStorage.setItem(MYREGS_KEY(), JSON.stringify(ids)); localStorage.removeItem(MYREG_KEY()); } catch(_) {}
}
let lastReceipt = null;   // {p1,p2,catId} — receipt card shown instead of the form

function renderMyReg() {
  const el = document.getElementById('reg-mine');
  if (!el) return;
  let ids = getMyRegs();
  // Drop registrations the organizer (or we) removed.
  if (regsLoaded) {
    const kept = ids.filter(id => registrations.some(r => r.id === id));
    if (kept.length !== ids.length) { setMyRegs(kept); ids = kept; }
  }
  const mine = ids.map(id => registrations.find(r => r.id === id)).filter(Boolean);
  if (!mine.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `<div><strong>${t('reg.mine')}</strong></div>` + mine.map(r => {
    const cat = categories.find(c => c.id === r.category);
    return `<div class="d-reg-mine-row">
      <div>
        <div>${dnH(regPairName(r))}${cat ? ` · <bdi>${escH(cat.name)}</bdi>` : ''}</div>
        <span class="status-badge badge-${escH(r.status)}">${escH(statusTxt(r.status))}</span>
        ${r.status !== 'rejected' ? `<span class="paid-badge${r.paid ? '' : ' no'}">${t(r.paid ? 'reg.paidBadge' : 'reg.unpaidBadge')}</span>` : ''}
      </div>
      ${r.status === 'pending' && !secure
        ? `<button type="button" class="reg-btn reject" onclick="cancelMyRegistration('${escH(r.id)}')">${t('common.cancel')}</button>`
        : `<span class="d-muted">${t('reg.cancelContact')}</span>`}
    </div>`;
  }).join('') + '<div id="mine-pay-wrap"></div>';
  // The form and the receipt carry their own pay buttons.
  const formShown = document.getElementById('reg-form-wrap')?.style.display !== 'none';
  if (!formShown && !lastReceipt && mine.some(r => !r.paid && r.status !== 'rejected')) renderPayLink('mine-pay-wrap');
}

async function cancelMyRegistration(id) {
  if (!getMyRegs().includes(id)) return;
  if (!await askConfirm(t('reg.confirmCancel'), t('reg.cancelReg'))) return;
  try {
    await deleteDoc(doc(db, 'tournaments', tId, 'registrations', id));
    setMyRegs(getMyRegs().filter(x => x !== id));
    lastReceipt = null;
    registrations = registrations.filter(r => r.id !== id);
    renderRegisterPage();
    toast(t('reg.cancelled'));
  } catch(e) { alert(t('errors.cancelFailed')); }
}

function renderReceipt() {
  const el = document.getElementById('reg-receipt');
  if (!el) return;
  if (!lastReceipt) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const cat = categories.find(c => c.id === lastReceipt.catId);
  el.style.display = '';
  el.innerHTML = `
    <div class="form-card d-receipt" role="status">
      <h3 class="d-receipt-title">${t('reg.receiptTitle')}</h3>
      <div class="d-receipt-line"><span class="d-muted">${t('reg.receiptPair')}</span> <strong>${dnH(lastReceipt.p1 + ' / ' + lastReceipt.p2)}</strong></div>
      <div class="d-receipt-line"><span class="d-muted">${t('reg.catLabel')}</span> <strong><bdi>${escH(cat ? cat.name : '')}</bdi></strong></div>
      <div class="d-receipt-line"><span class="d-muted">${t('reg.receiptStatus')}</span> <strong>${t('reg.pendingApproval')}</strong></div>
      <div id="receipt-pay-wrap"></div>
      <p id="receipt-pay-note" class="d-muted" style="display:none">${t('reg.payNote')}</p>
      <button type="button" class="submit-btn" onclick="registerAnother()">${t('reg.another')}</button>
    </div>`;
  renderPayLink('receipt-pay-wrap');
  const hasPay = !document.getElementById('receipt-pay-wrap')?.classList.contains('h');
  const note = document.getElementById('receipt-pay-note');
  if (note) note.style.display = hasPay ? '' : 'none';
}

function registerAnother() {
  lastReceipt = null;
  renderRegisterPage();
  document.getElementById('frm-p1')?.focus();
}

// Registration errors, per field: {p1, p2, phone, cat, form} → () => message.
// Kept as functions so a language switch re-renders them in the new language.
let regErrors = {};
const REG_FIELDS = { p1: 'frm-p1', p2: 'frm-p2', phone: 'frm-phone', email: 'frm-email', cat: 'frm-cat-wrap' };
function renderRegErrors() {
  Object.entries(REG_FIELDS).forEach(([k, id]) => {
    const msg = regErrors[k] ? regErrors[k]() : '';
    const el = document.getElementById(id + '-err');
    if (el) { el.textContent = msg; el.classList.toggle('h', !msg); }
    const inp = document.getElementById(id);
    if (inp) msg ? inp.setAttribute('aria-invalid', 'true') : inp.removeAttribute('aria-invalid');
  });
  const err = document.getElementById('frm-err');
  if (err) { err.textContent = regErrors.form ? regErrors.form() : ''; err.classList.toggle('h', !regErrors.form); }
}

async function submitRegistration() {
  const p1   = cleanName(document.getElementById('frm-p1').value);
  const p2   = cleanName(document.getElementById('frm-p2').value);
  const phoneRaw = document.getElementById('frm-phone').value.trim();
  const email = document.getElementById('frm-email').value.trim();
  const catId = document.querySelector('#frm-cat-wrap .cat-pill.on')?.dataset.value || '';
  const ok  = document.getElementById('frm-ok');
  ok.classList.add('h');
  const phone = normPhone(phoneRaw);
  regErrors = {
    p1: nameError(p1, 'common.player1'),
    p2: nameError(p2, 'common.player2'),
    phone: !phoneRaw ? () => t('errors.phoneRequired') : !phone ? () => t('errors.phoneInvalid') : null,
    email: secure && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? () => t('errors.emailInvalid') : null,
    cat: catId ? null : () => t('errors.catRequired'),
  };
  if (!regErrors.p1 && !regErrors.p2 && normName(p1) === normName(p2)) regErrors.p2 = () => t('errors.sameNames');
  if (!Object.values(regErrors).some(Boolean)) {
    const dup = findDuplicateReg(p1, p2, '', catId);
    if (dup) regErrors.form = () => t('errors.dupPair', { status: statusTxt(dup.status) });
  }
  renderRegErrors();
  const first = Object.keys(REG_FIELDS).find(k => regErrors[k]);
  if (first) { (first === 'cat' ? document.querySelector('#frm-cat-wrap .cat-pill') : document.getElementById(REG_FIELDS[first]))?.focus(); return; }
  if (regErrors.form) return;
  // meta is kept live by onSnapshot — the organizer may have closed registration
  // while this form was open.
  if (!regAccepting()) { regErrors = { form: () => t('reg.closed') }; renderRegisterPage(); return; }
  const btn = document.getElementById('frm-submit');
  if (btn?.disabled) return;           // double tap while a write is in flight
  const btnTxt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('reg.sending'); }
  const unlock = () => { if (btn) { btn.disabled = false; btn.textContent = btnTxt; } };
  try {
    const ref = secure
      ? await callFn('registerPair', { tId, p1, p2, phone, email, category: catId })
      : await addDoc(REGS_REF, {
          p1, p2, phone, category: catId,
          status: 'pending', paid: false,
          createdAt: serverTimestamp()
        });
    setMyRegs([...getMyRegs(), ref.id]);
    if (registrations.some(r => r.id !== ref.id && r.category === catId && r.status !== 'rejected' && normPhone(r.phone) === phone)) toast(t('errors.dupPhoneWarn'));
    document.getElementById('frm-p1').value = '';
    document.getElementById('frm-p2').value = '';
    document.getElementById('frm-phone').value = '';
    document.getElementById('frm-email').value = '';
    if (categories.length !== 1)
      document.querySelectorAll('#frm-cat-wrap .cat-pill').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
    unlock();
    regErrors = {};
    lastReceipt = { p1, p2, catId };
    renderRegisterPage();
    document.getElementById('reg-receipt')?.scrollIntoView({ block: 'nearest' });
  } catch(e) {
    unlock();
    regErrors = { form: () => t(e.code === 'functions/already-exists' ? 'errors.dupServer'
      : e.code === 'functions/failed-precondition' ? 'reg.closed' : 'errors.submitFailed') };
    renderRegErrors();
  }
}

// status: 'approved' | 'pending' | 'rejected' (soft, stays listed) | 'deleted' (hard delete).
async function setRegStatus(id, status) {
  if (!admin || meta.phase !== 'registration') return;
  try {
    if (status === 'deleted') {
      if (!await askConfirm(t('admin.confirmDelete'), t('common.delete'))) return;
      // Hard delete — also remove from build roster if present
      const reg = registrations.find(r => r.id === id);
      if (reg) {
        const catId = reg.category;
        const name = reg.p1 + (reg.p2 ? ' / ' + reg.p2 : '');
        await commitState(catId, cs => withdrawPair(catId, cs, name));
      }
      await deleteDoc(doc(db, 'tournaments', tId, 'registrations', id));
      registrations = registrations.filter(r => r.id !== id);
    } else {
      const r = registrations.find(r => r.id === id);
      await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { status });
      if (r) {
        const wasApproved = r.status === 'approved';
        r.status = status;
        // Any approval → make sure the pair is in its category's build roster.
        if (status === 'approved') await commitState(r.category, () => addRegToRoster(r));
        if (wasApproved && status !== 'approved') await commitState(r.category, cs => withdrawPair(r.category, cs, regPairName(r)));
      }
    }
    renderRegistrations();
    renderParticipants();
    renderBuildPage();
  } catch(e) { alert(t('errors.statusUpdate')); }
}

// Ensure an approved registration's pair is in its category roster.
// Empty roster → seed it from ALL approved registrations of that category (same
// as the Build page does), so approving one pair never hides the others.
// Returns true when the roster changed (caller pushes to cloud).
function regPairName(r) { return r.p1 + (r.p2 ? ' / ' + r.p2 : ''); }
function addRegToRoster(r) {
  const catId = r.category;
  if (!catId || !categories.some(c => c.id === catId)) return false;
  const cs = state[catId];
  if (!cs.roster.length) {
    cs.roster = approvedNames(catId);
    return cs.roster.length > 0;
  }
  const name = regPairName(r);
  if (cs.roster.some(n => normName(n) === normName(name))) return false;
  cs.roster.push(name);
  return true;
}
const approvedNames = catId => registrations.filter(r => r.status === 'approved' && r.category === catId).map(regPairName);
// The Build page shows approved registrations while the stored roster is still empty.
const seedRoster = (cs, catId) => { if (!cs.roster.length) cs.roster = approvedNames(catId); };
const hasScore = g => String(g.sa ?? '') !== '' || String(g.sb ?? '') !== '';

// Withdrawal without a rebuild: the pair leaves roster and group, only its unplayed
// pool games go; every other game keeps its court, time and score.
function withdrawPair(catId, cs, name) {
  seedRoster(cs, catId);
  const is = s => normName(s) === normName(name);
  const size = () => cs.roster.length + cs.sched.length + cs.groups.reduce((n, g) => n + g.teams.length, 0);
  const before = size();
  cs.roster = cs.roster.filter(x => !is(x));
  cs.groups.forEach(grp => { grp.teams = grp.teams.filter(x => !is(x)); });
  cs.sched = cs.sched.filter(g => g.gi < 0 || !(is(g.a) || is(g.b)) || hasScore(g));
  if (size() === before) return false;
  updateKOForCat(catId);
}

async function softRemoveReg(catId, name) {
  const reg = registrations.find(r => r.category === catId && r.status === 'approved' && normName(regPairName(r)) === normName(name));
  if (!reg) return;
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', reg.id), { status: 'pending' });
    reg.status = 'pending'; // stays listed; can be approved again
  } catch(e) { console.error('Could not update registration status', e); }
}

async function setRegPaid(id, paid) {
  if (!admin) return;
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { paid });
    const r = registrations.find(r => r.id === id);
    if (r) r.paid = paid;
    renderRegistrations();
  } catch(e) { alert(t('errors.paidUpdate')); renderRegistrations(); }
}

function selectRegCat(btn) {
  document.querySelectorAll('.cat-pill').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('on');
  btn.setAttribute('aria-pressed', 'true');
}

function setRegFilter(f) {
  regFilter = f;
  ['all','pending','approved','rejected'].forEach(k => {
    document.getElementById('rf-' + k)?.classList.toggle('on', k === f);
  });
  renderRegistrations();
}

function setRegPaidFilter(f) {
  regPaidFilter = f;
  ['all','paid','unpaid'].forEach(k => document.getElementById('rpf-' + k)?.classList.toggle('on', k === f));
  renderRegistrations();
}
function setRegSearch(v) { regSearch = v || ''; renderRegistrations(); }

// wa.me needs international digits: 05XXXXXXXX → 9725XXXXXXXX, +CC… → CC…. '' if invalid.
function waLink(phone) {
  const n = normPhone(phone);
  return n ? 'https://wa.me/' + (n[0] === '+' ? n.slice(1) : '972' + n.slice(1)) : '';
}

// Per-category counts (all statuses, not affected by filters).
function renderRegCounts() {
  const el = document.getElementById('reg-counts');
  if (!el) return;
  const rows = categories.map(c => {
    const rs = registrations.filter(r => r.category === c.id);
    const appr = rs.filter(r => r.status === 'approved').length;
    const pend = rs.filter(r => r.status === 'pending').length;
    const paid = rs.filter(r => r.paid).length;
    return `<span class="d-reg-count"><strong><bdi>${escH(c.name)}</bdi></strong> ${t('admin.counts', { total: rs.length, appr, pend, paid })}</span>`;
  });
  el.innerHTML = rows.join('');
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // keep spreadsheets from running formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Phone as a ="…" formula so Excel keeps the leading 0 / + (only for plain numbers).
const csvPhone = p => /^\+?\d+$/.test(p || '') ? `"=""${p}"""` : csvCell(p);
// Same rows as on screen: current language, local time, active filters.
function exportRegistrationsCSV() {
  if (!admin) return;
  const head = [t('common.player1'), t('common.player2'), t('reg.phoneLabel'), t('reg.catLabel'),
    t('csv.status'), t('admin.paid'), t('csv.created')];
  const lines = [head.map(csvCell).join(',')].concat(filteredRegs().map(r => {
    const cat = categories.find(c => c.id === r.category);
    // sv-SE formats as "2026-10-07 17:34:00" in the viewer's own time zone
    const at = r.createdAt?.seconds ? new Date(r.createdAt.seconds * 1000).toLocaleString('sv-SE') : '';
    return [csvCell(r.p1), csvCell(r.p2), csvPhone(r.phone), ...[cat ? cat.name : r.category, statusTxt(r.status),
      t(r.paid ? 'csv.yes' : 'csv.no'), at].map(csvCell)].join(',');
  }));
  // BOM so Excel opens Hebrew names as UTF-8
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `registrations-${(meta.name || tId).replace(/[\\/:*?"<>|]+/g, '-').trim()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function filteredRegs() {
  let list = [...registrations];
  if (regFilter !== 'all') list = list.filter(r => r.status === regFilter);
  if (regPaidFilter === 'paid')   list = list.filter(r => r.paid);
  if (regPaidFilter === 'unpaid') list = list.filter(r => !r.paid);
  const q = regSearch.trim().toLowerCase();
  if (q) {
    const qDigits = q.replace(/\D/g, '');
    list = list.filter(r => `${r.p1||''} ${r.p2||''}`.toLowerCase().includes(q)
      || (qDigits.length >= 3 && String(r.phone||'').replace(/\D/g, '').includes(qDigits)));
  }
  return list;
}

function renderRegistrations() {
  const el = document.getElementById('registrations-list');
  if (!el) return;
  renderRegCounts();
  const regPhase = meta.phase === 'registration';
  document.getElementById('regs-built-note')?.classList.toggle('h', regPhase);
  const list = filteredRegs();
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>${t('admin.noRegs')}</h3></div>`;
    return;
  }
  const toApprove = meta.phase === 'registration' ? list.filter(r => r.status !== 'approved').length : 0;
  el.innerHTML = (toApprove > 1 ? `<button type="button" class="filter-btn" style="margin-bottom:12px" onclick="approveAllShown()">${t('admin.approveAllShown', { n: toApprove })}</button>` : '')
    + list.map(r => {
    const cat = categories.find(c => c.id === r.category);
    const catName = cat ? cat.name : r.category;
    const wa = waLink(r.phone);
    const phoneHtml = wa
      ? `<a href="${escH(wa)}" target="_blank" rel="noopener" title="WhatsApp">${escH(r.phone)}</a>`
      : escH(r.phone||t('admin.noPhone'));
    return `<div class="reg-row status-${escH(r.status)}">
      <div class="reg-info">
        <div class="reg-name">${escH(regPairName(r))}</div>
        <div class="reg-meta"><bdi>${escH(catName)}</bdi> · <span class="num">${fmtDate(r.createdAt)}</span></div>
        <div class="reg-phone">${phoneHtml}</div>
      </div>
      <span class="status-badge badge-${escH(r.status)}">${escH(statusTxt(r.status))}</span>
      <label class="d-paid-toggle"><input type="checkbox" ${r.paid ? 'checked' : ''} aria-label="${escH(t('admin.paidFor', { pair: regPairName(r) }))}" onchange="setRegPaid('${r.id}',this.checked)"/> <span aria-hidden="true">${t('admin.paid')}</span></label>
      <div class="reg-actions">
        <button class="reg-btn" onclick="openEditReg('${r.id}')" title="${t('admin.editReg')}" aria-label="${t('admin.editReg')}">✎</button>
        ${regPhase ? `${r.status !== 'approved' ? `<button class="reg-btn approve" onclick="setRegStatus('${r.id}','approved')">${t('admin.approve')}</button>` : ''}
        ${r.status === 'approved'  ? `<button class="reg-btn" onclick="setRegStatus('${r.id}','pending')">${t('admin.undo')}</button>` : ''}
        ${r.status !== 'rejected'  ? `<button class="reg-btn reject" onclick="setRegStatus('${r.id}','rejected')">${t('admin.reject')}</button>` : ''}
        <button class="reg-btn reject" onclick="setRegStatus('${r.id}','deleted')" title="${t('admin.deleteTitle')}">${t('admin.delete')}</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderParticipants() {
  const el = document.getElementById('participants-list');
  const hiddenMsg = document.getElementById('participants-hidden-msg');
  if (!el) return;
  if (!meta.showRegistered && !superAdmin) {
    hiddenMsg?.classList.remove('h');
    el.innerHTML = '';
    return;
  }
  hiddenMsg?.classList.add('h');
  // Once a roster exists it is the truth (direct adds, renames); registrations only seed it.
  const pairsOf = cat => state[cat.id]?.roster?.length ? state[cat.id].roster
    : registrations.filter(r => r.status === 'approved' && r.category === cat.id).map(regPairName);
  if (!categories.some(c => pairsOf(c).length)) {
    el.innerHTML = `<div class="empty"><h3>${t('parts.empty')}</h3></div>`;
    return;
  }
  el.innerHTML = categories.map(cat => {
    const list = pairsOf(cat);
    if (!list.length) return '';
    return `<div class="part-cat">
      <div class="part-cat-title">${escH(cat.name)}</div>
      <div class="part-grid">${list.map((n,i) => `
        <div class="part-card">
          <span class="part-num num">${i+1}</span>
          <span class="part-name">${n.split('/').map(x => dnH(x.trim())).join(' / ')}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

// "pay.me/x" → "https://pay.me/x"; anything with its own scheme is left as is (and filtered below).
const payUrl = s => (s = String(s || '').trim()) && !/^[a-z][\w+.-]*:(?!\d)/i.test(s) ? 'https://' + s : s;
window.payUrl = payUrl;
function renderPayLink(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const links = [
    { url: payUrl(meta.paymentLink),  label: meta.paymentLinkLabel  || t('reg.payLink')  },
    { url: payUrl(meta.paymentLink2), label: meta.paymentLink2Label || t('reg.payLink2') },
  ].filter(l => /^https?:\/\//i.test(l.url || ''));   // only real http(s) links (blocks javascript: etc.)

  if (!links.length) { wrap.className = 'pay-section h'; wrap.innerHTML = ''; return; }

  wrap.className = 'pay-section';
  wrap.innerHTML = `
    <span class="pay-label">${t('reg.payment')}</span>
    <div class="pay-links">
      ${links.map(l => `<a class="pay-link-btn" href="${escH(l.url)}" target="_blank" rel="noopener">${escH(l.label)}</a>`).join('')}
    </div>`;
}

// Optional info card (date / venue / price) — hidden when none is set.
function fmtEventDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return v || '';
  const d = new Date(v + 'T00:00:00');
  return isNaN(d) ? v : d.toLocaleDateString(getLang() === 'he' ? 'he-IL' : 'en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}
function renderInfoCards() {
  const items = [
    ['date', fmtEventDate(meta.eventDate), 'bdi'],
    ['venue', meta.venue, 'bdi'],
    ['price', meta.price, 'num'],   // "₪120" / "120 ש״ח" — isolated so the digits keep their place
  ].filter(([, v]) => v && String(v).trim());
  const html = items.map(([ic, v, cls]) => `<span class="d-info-item"><span class="ic ic-${ic}" aria-hidden="true"></span><span class="${cls}">${escH(v)}</span></span>`).join('');
  ['reg-info-card', 'sched-info-card'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.style.display = items.length ? '' : 'none';
  });
}

// regNote (small markdown subset) → HTML. Escapes first; the first heading becomes the <summary>.
function mdNote(src, fallback) {
  const inl = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?![^\s.,;:!?)])/g, '$1<strong>$2</strong>')
    .replace(/https?:\/\/[^\s<]+?(?=[.,;:!?)]*(?:\s|<|$))/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  let summary = '', out = '', list = '', para = [];
  const flush = () => {
    if (para.length) out += `<p dir="auto">${para.join('<br>')}</p>`;
    if (list) out += `</${list}>`;
    para = []; list = '';
  };
  const lines = escH(src).split(/\r?\n/);
  const first = lines.findIndex(l => l.trim());
  if (first >= 0) summary = inl(lines.splice(first, 1)[0].replace(/^\s*(?:#{1,3}|[-•*]|\d+[.)])\s+/, '').trim());
  lines.forEach(line => {
    const h = line.match(/^\s*(#{1,3})\s+(.*)$/), li = line.match(/^\s*(?:([-•*])|\d+[.)])\s+(.*)$/);
    if (h) {
      flush();
      out += `<h${h[1].length + 2} dir="auto">${inl(h[2])}</h${h[1].length + 2}>`;
    } else if (li) {
      const tag = li[1] ? 'ul' : 'ol';
      if (para.length || list !== tag) { flush(); out += `<${tag} dir="auto">`; list = tag; }
      out += `<li>${inl(li[2])}</li>`;
    } else if (line.trim()) {
      if (list) flush();
      para.push(inl(line.trim()));
    } else flush();
  });
  flush();
  return `<details dir="auto"><summary><span>${summary || escH(fallback)}</span></summary>${out}</details>`;
}
function previewRegNote(ta) {
  const prev = ta?.nextElementSibling;
  if (!prev) return;
  prev.classList.toggle('h', !ta.value.trim());
  prev.innerHTML = mdNote(ta.value, t('reg.rulesSummary')).replace('<details', '<details open');
}
window.previewRegNote = previewRegNote;

function renderRegisterPage() {
  document.getElementById('frm-email-row')?.classList.toggle('h', !secure);
  renderInfoCards();
  const closedMsg = document.getElementById('reg-closed-msg');
  const formWrap  = document.getElementById('reg-form-wrap');
  const sub       = document.getElementById('reg-subtitle');
  const soonMsg   = document.getElementById('reg-soon-msg');
  const noCats    = !categories.length;
  const open      = regAccepting();
  // Closed wins over "opens soon"; with no categories there is nothing to register for.
  closedMsg?.classList.toggle('h', open);
  soonMsg?.classList.toggle('h', !open || !noCats);
  if (formWrap) formWrap.style.display = (open && !noCats && !lastReceipt) ? '' : 'none';
  renderMyReg();
  renderReceipt();
  if (sub) sub.innerHTML = meta.name ? t('reg.subtitle', { name: `<bdi>${escH(meta.name)}</bdi>` }) : '';
  const catWrap = document.getElementById('frm-cat-wrap');
  if (catWrap) {
    // Live snapshots re-render this page: keep the category the user already picked.
    const prevSel = catWrap.querySelector('.cat-pill.on')?.dataset.value || '';
    catWrap.innerHTML = categories.map(c =>
      `<button type="button" class="cat-pill${c.id === prevSel ? ' on' : ''}" aria-pressed="${c.id === prevSel}" data-value="${escH(c.id)}" onclick="selectRegCat(this)">${escH(c.name)}</button>`
    ).join('');
    if (categories.length === 1) { const b = catWrap.querySelector('.cat-pill'); b?.classList.add('on'); b?.setAttribute('aria-pressed', 'true'); }
    // One option: keep the (selected) pill hidden but tell the user which category it is.
    const single = categories.length === 1;
    catWrap.style.display = single ? 'none' : '';
    const catRow = catWrap.closest('.form-row');
    if (catRow) catRow.style.display = categories.length ? '' : 'none';
    const singleEl = document.getElementById('frm-cat-single');
    if (singleEl) {
      singleEl.style.display = single ? '' : 'none';
      singleEl.textContent = single ? categories[0].name : '';
    }
  }
  const noteEl = document.getElementById('reg-note');
  if (noteEl) {
    const has = !!String(meta.regNote || '').trim(), open = noteEl.querySelector('details')?.open;
    noteEl.className = 'reg-note md' + (has ? '' : ' h');
    noteEl.innerHTML = has ? mdNote(meta.regNote, t('reg.rulesSummary')) : '';
    if (open && has) noteEl.querySelector('details').open = true;
  }
  renderPayLink('reg-pay-wrap');
  renderRegErrors();
}

// ============ DIALOG / TOAST ============
// The app's own confirm dialog (replaces window.confirm). Resolves true on OK.
function askConfirm(msg, okLabel) {
  const m = document.getElementById('confirm-modal');
  const ok = document.getElementById('confirm-ok'), no = document.getElementById('confirm-cancel');
  document.getElementById('confirm-msg').textContent = msg;
  ok.textContent = okLabel || t('common.confirm');
  const back = document.activeElement;
  m.classList.remove('h');
  no.focus();
  return new Promise(resolve => {
    const done = v => {
      m.classList.add('h');
      ok.onclick = no.onclick = m.onclick = m.onkeydown = null;
      back?.focus?.();
      resolve(v);
    };
    ok.onclick = () => done(true);
    no.onclick = () => done(false);
    m.onclick = e => { if (e.target === m) done(false); };
    m.onkeydown = e => { if (e.key === 'Escape') done(false); };
  });
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('h');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('h'), 3500);
}

// ============ BUILD PAGE ============
let dragSrc = null;
let dragSrcCat = null;

function renderBuildPage() {
  const el = document.getElementById('build-cats');
  if (!el) return;
  el.innerHTML = '';

  // In 'built' phase show a status banner
  if (meta.phase === 'built') {
    const banner = document.createElement('div');
    banner.className = 'frm-ok';
    banner.textContent = t('build.builtBanner');
    el.appendChild(banner);
  }

  categories.forEach(cat => {
    if (!state[cat.id]) state[cat.id] = { roster:[], groups:[], sched:[], ko:[] };
    const cs = state[cat.id];
    seedRoster(cs, cat.id);
    const roster = cs.roster;

    const div = document.createElement('div');
    div.className = 'build-cat';
    const _bci = categories.indexOf(cat);
    div.dataset.ci = _bci;
    const _bColor = cat.color || '';
    const _bOn = /^#[0-9a-f]{6}$/i.test(_bColor) ? onColor(_bColor) : '';
    if (_bColor) { div.style.setProperty('--cat-color', _bColor); }
    if (_bOn)    { div.style.setProperty('--cat-on-color', _bOn); }
    div.innerHTML = `
      <div class="build-cat-head">
        <span class="build-cat-name">${escH(cat.name)}</span>
        <span class="build-cat-count">${t('build.pairsCount', { n: roster.length })}</span>
      </div>
      <div class="build-list" id="blist-${cat.id}" data-cat="${cat.id}"
        ondragover="onListDragOver(event)" ondrop="onListDrop(event,'${cat.id}')">
        ${roster.map((name,i) => buildItem(cat.id, name, i)).join('')}
      </div>
      <div class="build-foot">
        ${coordBuild() ? '' : `<button class="build-btn" onclick="buildTournament('${cat.id}')">${t(meta.phase === 'built' ? 'build.rebuild' : 'build.build')}</button>`}
        <button class="build-shuffle" onclick="shuffleBuildRoster('${cat.id}')">${t('build.shuffle')}</button>
        <button class="build-add-pair" onclick="openAddPair('${cat.id}')">${t('build.addPair')}</button>
      </div>`;
    el.appendChild(div);
    setupDragDrop(cat.id);
  });

  if (coordBuild() || (superAdmin && lastBuild)) {
    const bw = document.createElement('div');
    bw.className = 'build-foot';
    bw.innerHTML = (coordBuild() ? `<button class="build-btn" onclick="buildTournament()">${t(meta.phase === 'built' ? 'build.rebuildAll' : 'build.build')}</button>` : '')
      + (superAdmin && lastBuild ? `<button class="build-shuffle" onclick="undoLastBuild()">${t('build.undoLast')}</button>` : '');
    el.appendChild(bw);
  }

  // Start Tournament button — visible to any admin in registration / built phase
  const startWrap = document.createElement('div');
  startWrap.style.cssText = 'margin-top:24px;padding:16px;text-align:center;border-top:1px solid var(--border)';
  const startNote = t(meta.phase === 'built' ? 'build.startNoteBuilt' : 'build.startNoteReg');
  startWrap.innerHTML = `
    <p style="font-size:13px;color:var(--text3);margin-bottom:12px;line-height:1.5">${startNote}</p>
    <button class="gen-btn" onclick="openStartModal()" ${meta.phase !== 'built' || !categories.length ? 'disabled' : ''}>${t('build.start')}</button>`;
  el.appendChild(startWrap);
}

function buildItem(catId, name, i) {
  return `<div class="build-item" draggable="true" data-cat="${catId}" data-idx="${i}"
    ondragstart="onDragStart(event)" ondragover="onDragOver(event)"
    ondrop="onDrop(event,'${catId}')" ondragend="onDragEnd(event)">
    <span class="build-rank">${i+1}</span>
    <span class="build-name">${dnH(name)}</span>
    <button class="gedit-btn" onclick="editBuildItem('${catId}',${i})">${t('common.edit')}</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},-1)" title="${t('build.moveUp')}" aria-label="${t('build.moveUp')}">↑</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},1)" title="${t('build.moveDown')}" aria-label="${t('build.moveDown')}">↓</button>
    <button class="team-del" onclick="deleteBuildItem('${catId}',${i})" title="${t('common.remove')}" aria-label="${t('common.remove')}">✕</button>
  </div>`;
}

function editBuildItem(catId, idx) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const name = state[catId]?.roster[idx] || '';
  editTarget = { catId, buildIdx: idx, oldName: name };
  const parts = name.split('/').map(s => s.trim());
  document.getElementById('edit-p1').value = parts[0] || '';
  document.getElementById('edit-p2').value = parts[1] || '';
  document.getElementById('edit-modal-title').textContent = t('build.editPair');
  const catRow = document.getElementById('edit-cat-row');
  const catSel = document.getElementById('edit-cat');
  if (catRow && catSel) {
    catSel.innerHTML = categories.map(c =>
      `<option value="${escH(c.id)}"${c.id===catId?' selected':''}>${escH(c.name)}</option>`).join('');
    catRow.classList.remove('h');
  }
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}

async function deleteBuildItem(catId, idx) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const name = state[catId]?.roster[idx];
  if (!name || !await askConfirm(t('build.confirmRemove', { name }), t('common.remove'))) return;
  if (!await commitState(catId, cs => withdrawPair(catId, cs, name))) return;
  await softRemoveReg(catId, name);
  renderBuildPage();
  renderRegistrations();
}

function setupDragDrop(catId) {}

function onDragStart(e) {
  dragSrc    = e.currentTarget;
  dragSrcCat = dragSrc.dataset.cat;
  dragSrc.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over,.list-drag-over').forEach(el =>
    el.classList.remove('drag-over','list-drag-over'));
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const item = e.currentTarget;
  if (item !== dragSrc) {
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  }
}
function onListDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const list = e.currentTarget;
  document.querySelectorAll('.list-drag-over').forEach(el => el.classList.remove('list-drag-over'));
  list.classList.add('list-drag-over');
}
function onDrop(e, targetCatId) {
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget;
  if (!dragSrc || dragSrc === target) return;
  const fromIdx  = parseInt(dragSrc.dataset.idx);
  const toIdx    = parseInt(target.dataset.idx);
  const srcCatId = dragSrcCat;
  if (srcCatId === targetCatId) {
    const from = state[srcCatId]?.roster[fromIdx], to = state[srcCatId]?.roster[toIdx];
    if (from === undefined || to === undefined) return;
    commitState(srcCatId, cs => {
      seedRoster(cs, srcCatId);
      const i = cs.roster.indexOf(from), j = cs.roster.indexOf(to);
      if (i < 0 || j < 0) return false;
      cs.roster.splice(i, 1);
      cs.roster.splice(j, 0, from);
    }).then(renderBuildPage);
  } else {
    moveBetweenCategories(srcCatId, fromIdx, targetCatId, toIdx);
  }
}
function onListDrop(e, targetCatId) {
  e.preventDefault();
  if (!dragSrc) return;
  if (dragSrcCat === targetCatId) return; // item drop handles same-cat
  moveBetweenCategories(dragSrcCat, parseInt(dragSrc.dataset.idx), targetCatId, -1);
}
async function moveBetweenCategories(srcCatId, fromIdx, dstCatId, toIdx) {
  if (!state[srcCatId] || !state[dstCatId]) return;
  const name = state[srcCatId].roster[fromIdx], at = state[dstCatId].roster[toIdx];
  if (name === undefined) return;
  const ok = await commitState([srcCatId, dstCatId], () => {
    const src = state[srcCatId], dst = state[dstCatId];
    seedRoster(src, srcCatId); seedRoster(dst, dstCatId);
    const i = src.roster.indexOf(name);
    if (i < 0) return false;
    src.roster.splice(i, 1);
    const j = at === undefined ? -1 : dst.roster.indexOf(at);
    dst.roster.splice(j < 0 ? dst.roster.length : j, 0, name);
  });
  if (!ok) return;
  const reg = registrations.find(r => r.category === srcCatId && normName(regPairName(r)) === normName(name));
  if (reg) {
    try {
      await updateDoc(doc(db, 'tournaments', tId, 'registrations', reg.id), { category: dstCatId });
      reg.category = dstCatId;
    } catch(e) { console.error('Could not update registration category', e); }
  }
  renderBuildPage();
  renderRegistrations();
}

function moveBuildItem(catId, idx, dir) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const a = state[catId]?.roster[idx], b = state[catId]?.roster[idx + dir];
  if (a === undefined || b === undefined) return;
  commitState(catId, cs => {
    seedRoster(cs, catId);
    const i = cs.roster.indexOf(a), j = cs.roster.indexOf(b);
    if (i < 0 || j < 0) return false;
    [cs.roster[i], cs.roster[j]] = [b, a];
  }).then(renderBuildPage);
}

function shuffleBuildRoster(catId) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  if (!state[catId]) return;
  commitState(catId, cs => {
    seedRoster(cs, catId);
    for (let i = cs.roster.length-1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i+1));
      [cs.roster[i], cs.roster[j]] = [cs.roster[j], cs.roster[i]];
    }
  }).then(renderBuildPage);
}

function openAddPair(catId) {
  document.getElementById('ap-cat').innerHTML = categories.map(c =>
    `<option value="${escH(c.id)}" ${c.id===catId?'selected':''}>${escH(c.name)}</option>`).join('');
  document.getElementById('ap-p1').value = '';
  document.getElementById('ap-p2').value = '';
  document.getElementById('addpair-modal').classList.remove('h');
  document.getElementById('ap-p1').focus();
}
function closeAddPair() {
  document.getElementById('addpair-modal').classList.add('h');
}
async function saveAddPair() {
  if (!admin) return;
  const p1    = cleanName(document.getElementById('ap-p1').value);
  const p2    = cleanName(document.getElementById('ap-p2').value);
  const catId = document.getElementById('ap-cat').value;
  if (!p1 || !state[catId]) return;
  const r = { p1, p2, ...(secure ? {} : { phone:'' }), category: catId, status:'approved', paid:false };
  const name = regPairName(r);
  if (pairTaken(catId, name)) { toast(t('errors.dupName', { name: fsi(name) })); return; }
  await addDoc(REGS_REF, { ...r, createdAt: serverTimestamp() });
  await loadRegistrations();
  await commitState(catId, () => addRegToRoster(r));
  // Auto-save both players to the database
  if (p1) addPlayerToDB(p1, '');
  if (p2) addPlayerToDB(p2, '');
  closeAddPair();
  renderBuildPage();
}

// ===== COORDINATED MULTI-CATEGORY SCHEDULER (meta.coordinated, or >1 category) =====
// Schedules ALL categories on ONE shared court grid: no cross-category court/time
// collisions, the finale (last category) finishes last unless parallelCategories,
// pools before KO, no player in two games of a round, at most 2 games in a row and
// back-to-back only when nothing else fits. One slot length for every stage: courts =
// the most of any category, minutes/break/start from the first category. Runs on
// Build only. Reads state[cat].groups; writes sched/ko.
function coordCfg(){
  const courts = Math.max(2, ...categories.map(c=>(c.cfg||DEF_CAT_CFG).courts||2));
  const c0 = (categories[0] && categories[0].cfg) || DEF_CAT_CFG;
  const slot = (c0.gameDur||20) + (c0.breakDur||0);
  const start = t2m(meta.startTime || c0.startTime || '17:00');
  // Optional: a manual side-court (e.g. "King of the Court") reserves ONE court
  // for baseSlot*(players-1) minutes, then frees it back to the app. Convert that
  // duration into APP rounds (the base game length can differ from the app's).
  const b = meta.base || null;
  const baseDurMin = (b && b.sharesCourt && (b.players|0) > 1) ? ((b.slotMin||slot) * (b.players - 1)) : 0;
  const baseRounds = baseDurMin > 0 ? Math.ceil(baseDurMin / slot) : 0;
  return { COURTS:courts, SLOT:slot, START:start, BASE_ROUNDS:baseRounds };
}
function buildCoordinatedGroups(){
  categories.forEach(cat=>{
    const cs=state[cat.id]; if(!cs) return;
    let roster = cs.roster.length ? cs.roster :
      registrations.filter(r=>r.status==='approved'&&r.category===cat.id).map(r=>r.p1+(r.p2?' / '+r.p2:''));
    if(!roster.length){ cs.groups=[]; cs.sched=[]; cs.ko=[]; return; }
    const cfg=cat.cfg||DEF_CAT_CFG; const ng=cfg.numGroups||2;
    let groups;
    if(cfg.seeding==='snake') groups=snakeDistribute(roster,ng);
    else { const sizes=distributeGroups(roster.length,ng); groups=[]; let idx=0;
      for(let g=0;g<ng;g++){groups.push({name:String.fromCharCode(65+g),teams:roster.slice(idx,idx+sizes[g])}); idx+=sizes[g];} }
    cs.roster=roster; cs.groups=groups; cs.sched=[]; cs.ko=[];
  });
}
function generateCoordinatedSchedule(){
  const { COURTS, SLOT, START, BASE_ROUNDS } = coordCfg();
  // Courts available to the app in round r (a reserved side-court frees at BASE_ROUNDS).
  const courtsAt = r => (r < BASE_ROUNDS ? Math.max(2, COURTS-1) : COURTS);
  const cats = categories.filter(c => state[c.id] && (state[c.id].groups||[]).length);
  if(!cats.length) return;
  const finaleCat = cats[cats.length-1].id;
  const parallel = !!meta.parallelCategories;     // all categories run together, no forced finale
  const allPoolsFirst = !!meta.allPoolsBeforeKO;  // gate EVERY knockout round until ALL pools (all cats) are done
  const games=[], koStruct={};
  cats.forEach((cat,ci)=>{
    const groups=state[cat.id].groups; const poolIds=[];
    groups.forEach((grp,gi)=>rr(grp.teams).forEach(([a,b])=>{
      const id=`${cat.id}:P:${gi}:${a}#${b}`; poolIds.push(id);
      // Conflicts and rest are tracked per PLAYER, so one player in two categories is never double-booked.
      games.push({id,catId:cat.id,ci,kind:'pool',gi,gn:grp.name,a,b,teams:[a,b].flatMap(p=>p.split(' / ').map(normName))});

    }));
    const cfg=cat.cfg||DEF_CAT_CFG; const adv=cfg.advPerGroup||0, ng=groups.length;
    if(adv>=1 && ng>=1){
      const seeds=[]; for(let rank=1;rank<=adv;rank++) for(let g=0;g<ng;g++) seeds.push(`${String.fromCharCode(65+g)}${rank}`);
      let bs=1; while(bs<seeds.length) bs*=2; while(seeds.length<bs) seeds.push('TBD');
      const rounds=[], first=[];
      // Padding 'TBD' = no opponent: a bye, not a game that never resolves.
      for(let i=0;i<bs/2;i++) first.push(seeds[bs-1-i]==='TBD'
        ? {isBye:true,a:seeds[i],b:'',seedA:seeds[i],seedB:'',sa:'',sb:'',catId:cat.id}
        : {a:seeds[i],b:seeds[bs-1-i],seedA:seeds[i],seedB:seeds[bs-1-i],sa:'',sb:'',catId:cat.id});
      // 4 QFs: swap QF3/QF4 so the cross SF (QF1×QF4, QF2×QF3) never pairs a group with itself.
      if(first.length===4 && !first.some(g=>g.isBye)) [first[2],first[3]]=[first[3],first[2]];
      rounds.push(first);
      let m=first.length/2;
      while(m>=1){const rd=[]; for(let i=0;i<m;i++) rd.push({a:`W${i*2+1}`,b:`W${i*2+2}`,sa:'',sb:'',catId:cat.id}); rounds.push(rd); m=Math.floor(m/2);}
      koStruct[cat.id]=rounds;
      rounds.forEach((rd,ri)=>rd.forEach((g,gi)=>{ if(!g.isBye) games.push({id:`${cat.id}:K${ri}:${gi}`,catId:cat.id,ci,kind:'ko',ri,gi,ref:g,poolIds,lastRound:ri===rounds.length-1}); }));
      const sfRound=rounds.length-2;
      if(sfRound>=0) games.push({id:`${cat.id}:3P`,catId:cat.id,ci,kind:'ko3p',sfRound,
        ref:{catId:cat.id,gi:-1,isThirdPlace:true,a:'Loser of SF1',b:'Loser of SF2',sa:'',sb:''}});
    }
  });
  const koRoundIds={};
  games.forEach(g=>{ if(g.kind==='ko')(koRoundIds[`${g.catId}:${g.ri}`]=koRoundIds[`${g.catId}:${g.ri}`]||[]).push(g.id); });
  const allPoolIds = games.filter(g=>g.kind==='pool').map(g=>g.id);
  const ready=(g,done)=>{
    if(g.kind==='pool') return true;
    if(allPoolsFirst && !allPoolIds.every(id=>done.has(id))) return false; // all pools first
    if(g.kind==='ko3p') return (koRoundIds[`${g.catId}:${g.sfRound}`]||[]).every(id=>done.has(id));
    if(!g.poolIds.every(id=>done.has(id))) return false;
    if(g.ri===0) return true;
    return (koRoundIds[`${g.catId}:${g.ri-1}`]||[]).every(id=>done.has(id));
  };
  const isFinaleLast=g=> !parallel && g.catId===finaleCat && ((g.kind==='ko'&&g.lastRound)||g.kind==='ko3p');
  const rankKind=g=>g.kind==='pool'?1:0, koOrder=g=>g.kind==='ko3p'?99:(g.kind==='ko'?g.ri:0);
  const rounds=[], done=new Set(); let rem=new Set(games.map(g=>g.id));
  const byId=Object.fromEntries(games.map(g=>[g.id,g])); const teamRounds={};
  const played=t=>teamRounds[t]||new Set();
  let guard=0;
  const poolPending=cid=>games.some(g=>g.catId===cid&&g.kind==='pool'&&rem.has(g.id));
  const grpLeft=g=>games.filter(x=>x.kind==='pool'&&x.catId===g.catId&&x.gi===g.gi&&rem.has(x.id)).length;

  while(rem.size && guard++<500){
    const r=rounds.length;
    const courtsThisRound=courtsAt(r);
    // Optional block-scheduling: don't pull the finale category forward while an
    // earlier category still has unplayed pool games (avoids isolating a finale
    // pair with a lone early game -> long waiting gap). Opt-in via meta flag.
    const gateFinale = meta.blockFinaleUntilPoolsDone &&
      cats.some(c=>c.id!==finaleCat && poolPending(c.id));
    const cand=[...rem].map(id=>byId[id]).filter(g=>ready(g,done)&&!isFinaleLast(g)
      && !(gateFinale && g.catId===finaleCat));
    if(!cand.length){
      // Only the finale's closing games (final + 3rd) are left for their own round.
      // (Restrict to finaleLast so a gated finale can't dump its pool games here.)
      const fin=[...rem].map(id=>byId[id]).filter(g=>ready(g,done)&&isFinaleLast(g)).slice(0,courtsThisRound);
      if(fin.length){rounds.push(fin.map(g=>g.id)); fin.forEach(g=>{done.add(g.id);rem.delete(g.id);}); continue;}
      rounds.push([]); if(rounds.length>200) break; continue;
    }
    const lastPlayed=t=>{const s=played(t); return s.size?Math.max(...s):-99;};
    const phase=g=> parallel ? 0 : (g.catId===finaleCat?1:0);
    cand.sort((x,y)=>{
      if(phase(x)!==phase(y)) return phase(x)-phase(y);
      const kx=rankKind(x),ky=rankKind(y); if(kx!==ky) return kx-ky;
      if(kx===0) return (koOrder(x)-koOrder(y))||((x.gi||0)-(y.gi||0));
      // The most tired pair decides; then the group with more games left.
      const wx=Math.min(...x.teams.map(t=>r-lastPlayed(t))), wy=Math.min(...y.teams.map(t=>r-lastPlayed(t)));
      return (wy-wx)||(grpLeft(y)-grpLeft(x));
    });
    const chosen=[], usedTeams=new Set(), seenKO=new Set();
    const rested=g=>!g.teams.some(t=>played(t).has(r-1));
    // Back-to-back games only fill courts that no rested pool game can take.
    for(const pass of [0,1]) for(const g of cand){
      if(chosen.length>=courtsThisRound) break;
      if(g.kind==='pool'){
        if(chosen.includes(g) || g.teams.some(t=>usedTeams.has(t))) continue;
        if(g.teams.some(t=>played(t).has(r-1)&&played(t).has(r-2))) continue;
        if(!pass && !rested(g)) continue;
        g.teams.forEach(t=>usedTeams.add(t)); chosen.push(g);
      } else if(pass) continue;
      else if(g.kind==='ko3p'){ chosen.push(g); }

      else {
        const sk=`${g.catId}:${g.ri}`; if(seenKO.has(sk)) continue; seenKO.add(sk);
        const stage=(koRoundIds[sk]||[]).map(id=>byId[id]).filter(x=>rem.has(x.id)&&ready(x,done)&&!isFinaleLast(x));
        // Place as many of this KO stage as fit; the rest wait for the next round.
        // ready() keeps the following KO round gated until ALL of this one is done,
        // so splitting a large stage (e.g. a 4-game QF on 3 courts) stays correct.
        const free=courtsThisRound-chosen.length;
        stage.slice(0,Math.max(0,free)).forEach(x=>chosen.push(x));
      }
    }
    if(!chosen.length){rounds.push([]); continue;}
    rounds.push(chosen.map(g=>g.id));
    chosen.forEach(g=>{done.add(g.id);rem.delete(g.id); if(g.kind==='pool')g.teams.forEach(t=>{(teamRounds[t]=teamRounds[t]||new Set()).add(r);});});
  }
  // Dinner exactly at the pool->knockout boundary: all pools done -> break -> KO.
  // Computes the concrete time and writes it into meta.breaks so the board + print
  // sheets show the marker (buildTournament persists it with the build).
  if(meta.breakBeforeKO){
    let P=-1;
    for(let r=0;r<rounds.length;r++){ if(rounds[r].some(id=>byId[id]&&byId[id].kind!=='pool')){ P=r; break; } }
    meta.breaks = (P>0) ? [{atTime:m2t(START+P*SLOT), minutes:meta.breakBeforeKO}] : [];
  }
  // Global breaks (e.g. a Friday-dinner pause on ALL courts): any round whose base
  // time is at/after a break start is pushed later by that break's minutes. Base and
  // app shift equally, so the court-reservation math (in round indices) is unaffected.
  const brs = (meta.breaks||[]).map(b=>({at:t2m(b.atTime), min:b.minutes||0})).sort((a,b)=>a.at-b.at);
  const roundTime = r => { let t=START+r*SLOT; for(const b of brs) if(t>=b.at) t+=b.min; return t; };
  cats.forEach(c=>{ state[c.id].sched=[]; state[c.id].ko=(koStruct[c.id]||[]).map(rd=>rd.map(g=>g.isBye?g:null)); });
  // Each pool game first gets the court its group played on last (fixed court per
  // group, also with odd group sizes); the other games fill the free courts in order.
  const grpCourt={};
  rounds.forEach((ids,r)=>{ const time=m2t(roundTime(r));
    const courtOf={}, taken=new Set(), gk=g=>`${g.catId}:${g.gi}`;
    ids.forEach(id=>{ const g=byId[id], c=g.kind==='pool'&&grpCourt[gk(g)];
      if(c && c<=courtsAt(r) && !taken.has(c)){ courtOf[id]=c; taken.add(c); } });
    let next=1;
    ids.forEach(id=>{ if(courtOf[id]) return; while(taken.has(next)) next++; courtOf[id]=next; taken.add(next); });
    ids.forEach(id=>{ const g=byId[id], court=courtOf[id];
      if(g.kind==='pool') grpCourt[gk(g)]=court;

      if(g.kind==='pool') state[g.catId].sched.push({catId:g.catId,gi:g.gi,gn:g.gn,a:g.a,b:g.b,sa:'',sb:'',court,si:r,time});
      else if(g.kind==='ko3p') state[g.catId].sched.push({...g.ref,court,si:r,time});
      else state[g.catId].ko[g.ri][g.gi]={...g.ref,court,si:r,time};
    });
  });
  categories.forEach(c=>{ if(state[c.id]) updateKOForCat(c.id); });
}

// More than one category always shares one court grid (separate grids double-book courts).
const coordBuild = () => !!meta.coordinated || categories.length > 1;
const allGamesOf = cs => [...cs.sched, ...cs.ko.flat().filter(g => !g.isBye)];

// A rebuild keeps scores of games that still exist with the same two pairs: pool by
// pair, KO by position in a bracket of the same shape. Manual court/time is not kept
// (it could collide with the new grid).
const koKey = (cid, cs, ri, gi) => `${cid}|K|${cs.ko.length}|${ri}|${cs.ko[ri].length}|${gi}`;
function gameIndex(cids) {
  const m = new Map();
  cids.forEach(cid => {
    const cs = state[cid]; if (!cs) return;
    cs.sched.forEach(g => m.set(g.gi < 0 ? `${cid}|3P` : `${cid}|${pairKey(g.a, g.b)}`, g));
    cs.ko.forEach((r, ri) => r.forEach((g, gi) => m.set(koKey(cid, cs, ri, gi), g)));
  });
  return m;
}
function carryOver(cids, old) {
  const same = (g, o) => normName(g.a) === normName(o.a) && normName(g.b) === normName(o.b);
  const take = (g, o, swap) => {
    if (!hasScore(o)) return;
    [g.sa, g.sb] = swap ? [o.sb, o.sa] : [o.sa, o.sb];
    ['wo', 'forced'].forEach(k => { if (o[k]) g[k] = o[k]; });
  };
  cids.forEach(cid => {
    const cs = state[cid];
    if (!cs) return;
    cs.sched.forEach(g => { const o = g.gi >= 0 && old.get(`${cid}|${pairKey(g.a, g.b)}`); if (o) take(g, o, !same(g, o)); });
    updateKOForCat(cid);
    cs.ko.forEach((r, ri) => {
      r.forEach((g, gi) => { const o = old.get(koKey(cid, cs, ri, gi)); if (o && same(g, o)) take(g, o); });
      updateKOForCat(cid);
    });
    const g3 = cs.sched.find(g => g.gi < 0), o3 = old.get(`${cid}|3P`);
    if (g3 && o3 && same(g3, o3)) take(g3, o3);
  });
}

async function buildTournament(catId) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const coord = coordBuild();
  const cids = coord ? categories.map(c => c.id) : [catId];
  if (!cids.some(id => state[id]?.roster.length || approvedNames(id).length)) { alert(t('errors.noApproved')); return; }
  const rebuild = meta.phase === 'built';
  if (rebuild) {
    const games = cids.flatMap(id => state[id] ? allGamesOf(state[id]) : []);
    const msg = t('build.confirmRebuild') + '\n' + t('build.confirmCounts', { cats: cids.length,
      pairs: cids.reduce((n, id) => n + (state[id]?.roster.length || 0), 0),
      scores: games.filter(hasScore).length, manual: games.filter(g => g.manual).length });
    if (!await askConfirm(msg, t(coord ? 'build.rebuildAll' : 'build.rebuild'))) return;
  }
  const prev = { phase: meta.phase, breaks: meta.breaks ?? null, regOpen: !!meta.regOpen };
  let backup;
  const ok = await commitState(cids, () => {
    backup = Object.fromEntries(cids.map(id => [id, catStateToFB(structuredClone(state[id]))]));
    const old = gameIndex(cids);
    if (coord) { buildCoordinatedGroups(); generateCoordinatedSchedule(); }
    else if (!buildCategory(catId)) return false;
    carryOver(cids, old);
    const extra = { lastBuild: { at: serverTimestamp(), ...prev, state: backup } };
    if (meta.breakBeforeKO) extra['meta.breaks'] = meta.breaks;
    if (!rebuild) { extra['meta.phase'] = 'built'; extra['meta.regOpen'] = false; }
    return extra;
  });
  if (!ok) return;
  lastBuild = { at: { seconds: Date.now() / 1000 }, ...prev, state: backup };
  if (!rebuild) meta.regOpen = false;

  // First build → 'built' phase so the tournament tabs become visible
  if (!rebuild) { meta.phase = 'built'; renderAll(); goPage('standings'); }
  else renderBuildPage();
}

async function undoLastBuild() {
  const lb = lastBuild;
  if (!superAdmin || !lb?.state || meta.phase === 'tournament') return;
  const at = lb.at?.seconds ? new Date(lb.at.seconds * 1000).toTimeString().slice(0, 5) : '';
  if (!await askConfirm(t('build.confirmUndo', { at }), t('build.undoLast'))) return;
  const cids = Object.keys(lb.state).filter(id => categories.some(c => c.id === id));
  const ok = await commitState(cids, () => {
    cids.forEach(id => { state[id] = catStateFromFB(structuredClone(lb.state[id])); });
    return { 'meta.phase': lb.phase, 'meta.breaks': lb.breaks ?? deleteField(), 'meta.regOpen': lb.regOpen ?? !!meta.regOpen, lastBuild: deleteField() };
  });
  if (!ok) return;
  meta.phase = lb.phase;
  if (lb.regOpen !== undefined) meta.regOpen = lb.regOpen;
  if (lb.breaks) meta.breaks = lb.breaks; else delete meta.breaks;
  lastBuild = null;
  renderAll(); goPage('build');
}

// Pure part of a single-category build (mirrored in core/legacy.js).
function buildCategory(catId) {
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cat || !cs) return false;

  let roster = cs.roster.length ? cs.roster :
    registrations.filter(r => r.status === 'approved' && r.category === catId)
      .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));

  if (!roster.length) return false;

  const cfg = cat.cfg || DEF_CAT_CFG;
  const ng  = cfg.numGroups || 2;
  let groups;
  if (cfg.seeding === 'snake') {
    groups = snakeDistribute(roster, ng);
  } else {
    const sizes = distributeGroups(roster.length, ng);
    groups = [];
    let idx = 0;
    for (let g = 0; g < ng; g++) {
      groups.push({ name: String.fromCharCode(65+g), teams: roster.slice(idx, idx+sizes[g]) });
      idx += sizes[g];
    }
  }
  cs.roster = roster;
  cs.groups = groups;
  cs.sched  = [];
  cs.ko     = [];
  generateScheduleForCat(catId);
  return true;
}

// ============ SCHEDULE GENERATION ============
function t2m(t) { const [h,m] = (t||'00:00').split(':').map(Number); return h*60+m; }
function m2t(m) { return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function addM(t, m) { return m2t(t2m(t)+m); }

function rr(teams) {
  if (teams.length < 2) return [];
  const list = teams.length % 2 === 0 ? [...teams] : [...teams, 'BYE'];
  const half = list.length / 2;
  const games = [];
  for (let r = 0; r < list.length - 1; r++) {
    for (let i = 0; i < half; i++) {
      const a = list[i], b = list[list.length-1-i];
      if (a !== 'BYE' && b !== 'BYE') games.push([a,b]);
    }
    list.splice(1, 0, list.pop());
  }
  return games;
}

function distributeGroups(nc, ng) {
  const base = Math.floor(nc/ng), extra = nc % ng;
  return Array.from({length:ng}, (_,i) => base + (i<extra?1:0));
}

// Serpentine ("snake") seeding for ranking tournaments: the roster is assumed
// sorted best-first, and is dealt into pools A→…→last, then back, so each pool
// gets one team from every ranking tier and pools stay balanced.
function snakeDistribute(roster, ng) {
  const groups = Array.from({length:ng}, (_,i) => ({ name:String.fromCharCode(65+i), teams:[] }));
  let g = 0, dir = 1;
  for (let i = 0; i < roster.length; i++) {
    groups[g].teams.push(roster[i]);
    if (dir === 1) { if (g === ng-1) dir = -1; else g++; }
    else           { if (g === 0)    dir = 1;  else g--; }
  }
  return groups;
}

// Lexicographic tuple compare (higher is better). Returns >0 if a beats b.
function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

function roundName(count) {
  if (count===2)  return 'Final';
  if (count===4)  return 'Semifinals';
  if (count===8)  return 'Quarterfinals';
  if (count===16) return 'Round of 16';
  if (count===32) return 'Round of 32';
  return `Round of ${count}`;
}
function getKORoundName(catId, ri) {
  const cs = state[catId];
  if (!cs||!cs.ko[ri]) return '';
  // Use position from end (0=Final, 1=SF, 2=QF, 3=R16...)
  const fromEnd = cs.ko.length - 1 - ri;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  if (fromEnd === 3) return 'Round of 16';
  return `Round of ${Math.pow(2,fromEnd+1)}`;
}

// Pool schedule built in PHASES of `nc` groups (e.g. 2 groups on 2 courts):
// all games of a phase are pooled across every court — minimal idle time, balanced
// rest, never double-booking a couple — and the next phase starts only after the
// current one finishes. Keeps "first 2 groups, then next 2 groups, then knockout",
// and auto-compacts when a group is smaller (e.g. after a withdrawal).
// Slot times are CUMULATIVE: each slot lasts as long as the stage played in it,
// using the per-stage `dur` from koRules (falling back to the category's Game min).
// This lets e.g. pool/R16 run 15 min while QF onward run 20 min.
function assignSlotTimes(catId) {
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cs || !cat) return;
  const cfg   = cat.cfg || DEF_CAT_CFG;
  const rules = { ...DEF_KO_RULES, ...(cfg.koRules||{}) };
  const durOf = s => (rules[s] && rules[s].dur) || cfg.gameDur || 30;
  const brk   = cfg.breakDur || 0;

  const slotDur = {};
  const note = (si, d) => { if (si >= 0) slotDur[si] = Math.max(slotDur[si]||0, d); };
  (cs.sched||[]).forEach(g => note(g.si, g.isThirdPlace ? durOf('third') : durOf('pool')));
  (cs.ko||[]).forEach((round, ri) => round.forEach(g => {
    if (g.isBye) return;
    const fromEnd = cs.ko.length - 1 - ri;
    note(g.si, durOf(fromEnd===0 ? 'final' : fromEnd===1 ? 'sf' : fromEnd===2 ? 'qf' : 'r16'));
  }));

  const timeOf = {};
  let clock = t2m(cfg.startTime || '08:00');
  Object.keys(slotDur).map(Number).sort((a,b)=>a-b).forEach(si => {
    timeOf[si] = m2t(clock);
    clock += slotDur[si] + brk;
  });
  (cs.sched||[]).forEach(g => { if (timeOf[g.si] !== undefined) g.time = timeOf[g.si]; });
  (cs.ko||[]).forEach(round => round.forEach(g => {
    if (!g.isBye && timeOf[g.si] !== undefined) g.time = timeOf[g.si];
  }));
}

function genPoolSched(catId) {
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cs || !cat) return [];
  const cfg = cat.cfg || DEF_CAT_CFG;
  const slotDur = (cfg.gameDur||30) + (cfg.breakDur||0);
  const nc = cfg.courts || 2;
  const courtList = []; for (let c = 0; c < nc; c++) courtList.push(c + 1);

  const scheduled = [];
  let psi = 0;
  for (let p = 0; p < cs.groups.length; p += nc) {          // one phase per `nc` groups
    const remaining = [];
    for (let gi = p; gi < Math.min(p + nc, cs.groups.length); gi++) {
      const grp = cs.groups[gi];
      const homeCourt = ((gi - p) % nc) + 1;
      rr(grp.teams).forEach(([a,b]) =>
        remaining.push({ catId, gi, gn:grp.name, a, b, sa:'', sb:'', homeCourt, court:homeCourt }));
    }
    const poolRem = {};
    remaining.forEach(g => { poolRem[g.gi] = (poolRem[g.gi]||0) + 1; });
    const lastSlot = {};
    while (remaining.length && psi < 1000) {
      const used = new Set();
      courtList.forEach(court => {
        let best = null, bestScore = null, bestIdx = -1;
        for (let i = 0; i < remaining.length; i++) {
          const g = remaining[i];
          if (used.has(g.a) || used.has(g.b)) continue;
          const home    = g.homeCourt === court ? 1 : 0;
          const restA   = psi - (g.a in lastSlot ? lastSlot[g.a] : psi - 3);
          const restB   = psi - (g.b in lastSlot ? lastSlot[g.b] : psi - 3);
          const minRest = Math.min(restA, restB, 2);
          const score   = [home, minRest, poolRem[g.gi] || 0];
          if (bestScore === null || cmpScore(score, bestScore) > 0) { best = g; bestScore = score; bestIdx = i; }
        }
        if (!best) return;
        best.si = psi; best.court = court;
        best.time = addM(cfg.startTime||'08:00', psi*slotDur);
        used.add(best.a); used.add(best.b);
        lastSlot[best.a] = psi; lastSlot[best.b] = psi;
        poolRem[best.gi]--;
        scheduled.push(best);
        remaining.splice(bestIdx, 1);
      });
      psi++;
    }
  }
  return scheduled;
}

function generateScheduleForCat(catId) {
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cs || !cat) return;
  const cfg = cat.cfg || DEF_CAT_CFG;
  const slotDur = (cfg.gameDur||30) + (cfg.breakDur||0);
  const nc = cfg.courts || 2;

  // ---- Pool-stage schedule (phased across groups; see genPoolSched) ----
  const scheduled = genPoolSched(catId);
  cs.sched = scheduled;

  const adv = cfg.advPerGroup || 0;
  const ng  = cs.groups.length;
  if (adv < 1) { cs.ko = []; assignSlotTimes(catId); return; }

  // Custom QUEEN knockout (ranking format): #1 gets a bye to the QF, #2/#3 play the
  // Round of 16 with the poster's cross pairings, then QF/SF/3rd/Final.
  if (cfg.koFormat === 'queen' && ng === 4) {
    const lastSiQ = scheduled.length ? Math.max(...scheduled.map(g=>g.si)) : 0;
    buildQueenKO(catId, cfg, nc, slotDur, cfg.startTime||'08:00', lastSiQ + 1);
    assignSlotTimes(catId);
    return;
  }

  const koSeeds = [];
  for (let rank=1; rank<=adv; rank++)
    for (let g=0; g<ng; g++)
      koSeeds.push(`${String.fromCharCode(65+g)}${rank}`);

  let bracketSize = 1;
  while (bracketSize < koSeeds.length) bracketSize *= 2;
  while (koSeeds.length < bracketSize) koSeeds.push('TBD');

  cs.ko = [];
  const lastSi = scheduled.length ? Math.max(...scheduled.map(g=>g.si)) : 0;
  let rs = lastSi + 1;

  const firstRound = [];
  for (let i=0; i<bracketSize/2; i++) {
    const aSeed = koSeeds[i], bSeed = koSeeds[bracketSize-1-i];
    firstRound.push(bSeed === 'TBD'
      ? { isBye:true, a:aSeed, b:'', seedA:aSeed, seedB:'', sa:'', sb:'', catId }
      : { a:aSeed, b:bSeed, seedA:aSeed, seedB:bSeed, sa:'', sb:'', catId });
  }
  // 4 QFs: swap QF3/QF4 so the cross SF (QF1×QF4, QF2×QF3) never pairs a group with itself.
  if (firstRound.length === 4 && !firstRound.some(g => g.isBye)) [firstRound[2], firstRound[3]] = [firstRound[3], firstRound[2]];

  firstRound.filter(g => !g.isBye).forEach((g, gi) => {
    g.court = (gi % nc) + 1;
    g.si    = rs + Math.floor(gi/nc);
    g.time  = addM(cfg.startTime||'08:00', g.si*slotDur);
  });
  rs += Math.ceil(firstRound.filter(g => !g.isBye).length / nc);

  cs.ko.push(firstRound);

  let matches = firstRound.length / 2;
  while (matches >= 1) {
    const prevName = getKORoundName(catId, cs.ko.length-1);
    const round = [];
    for (let i=0; i<matches; i++) {
      round.push({
        a: `Winner of ${prevName} ${i*2+1}`,
        b: `Winner of ${prevName} ${i*2+2}`,
        sa:'', sb:'', catId,
        court: (i%nc)+1,
        si: rs + Math.floor(i/nc),
        time: addM(cfg.startTime||'08:00', (rs+Math.floor(i/nc))*slotDur)
      });
    }
    rs += Math.ceil(round.length/nc);
    cs.ko.push(round);
    matches = Math.floor(matches/2);
  }
  assignSlotTimes(catId);
}

// QUEEN ranking knockout: 4 pools, top-3 advance (#4 out).
//   r0 = Round of 16 with byes:  [BYE A1, B2vA3, BYE B1, A2vB3, BYE C1, D2vC3, BYE D1, C2vD3]
//   r1 = QF (#1 seeds join),  r2 = SF (cross),  r3 = Final;  3rd-place lives in sched.
// Labels for QF/SF/Final are filled by updateKOForCat (byes resolve, SF crosses).
function buildQueenKO(catId, cfg, nc, slotDur, startTime, rs) {
  const cs  = state[catId];
  const bye = s        => ({ isBye:true, a:s, b:'', seedA:s, seedB:'', sa:'', sb:'', catId });
  const r16 = (sa, sb) => ({ a:sa, b:sb, seedA:sa, seedB:sb, sa:'', sb:'', catId });
  const gp  = ()       => ({ a:'', b:'', sa:'', sb:'', catId });
  const r0  = [ bye('A1'), r16('B2','A3'), bye('B1'), r16('A2','B3'),
                bye('C1'), r16('D2','C3'), bye('D1'), r16('C2','D3') ];
  const qf  = [gp(), gp(), gp(), gp()];
  const sf  = [gp(), gp()];
  const fin = [gp()];
  cs.ko = [r0, qf, sf, fin];

  // Schedule only the real (non-bye) games, round by round across the courts.
  const schedRound = games => {
    const real = games.filter(g => !g.isBye);
    real.forEach((g, i) => {
      g.court = (i % nc) + 1;
      g.si    = rs + Math.floor(i / nc);
      g.time  = addM(startTime, g.si * slotDur);
    });
    rs += Math.max(1, Math.ceil(real.length / nc));
  };
  schedRound(r0); schedRound(qf); schedRound(sf); schedRound(fin);

  // 3rd-place game — parallel with the final on the next court (own slot if 1 court).
  const finGame  = fin[0];
  const parallel = nc >= 2;
  cs.sched.push({
    catId, gi:-1, isThirdPlace:true, a:'Loser of SF1', b:'Loser of SF2', sa:'', sb:'',
    court: parallel ? finGame.court + 1 : finGame.court,
    si:    parallel ? finGame.si       : finGame.si + 1,
    time:  parallel ? finGame.time     : addM(startTime, (finGame.si + 1) * slotDur)
  });
}

// ============ SCORE VALIDATION ============
function isValidScore(sa, sb, catId, rule, g) {
  if (isNaN(sa)||isNaN(sb)||sa===''||sb==='') return false;
  if (sa < 0 || sb < 0) return false;
  if (g?.forced || g?.wo) return sa !== sb;
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  const r = rule && typeof rule === 'object' ? rule : { pts: rule };
  if ((r.sets ?? cfg.sets) === 3) {
    const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
    return (hi===2 && lo>=0 && lo<=1);
  }
  const ptw = r.pts || cfg.pointsToWin || 21;
  if (sa===sb) return false;
  const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
  if (hi < ptw) return false;
  if (hi===ptw) return hi-lo>=2;
  return hi-lo===2;
}

function scoreError(sa, sb, catId, rule, g) {
  if (sa===''||sb==='') return null;
  const a=parseInt(sa), b=parseInt(sb);
  if (isNaN(a)||isNaN(b)) return null;
  if (a < 0 || b < 0) return { key:'score.nonNegative' };
  if (g?.forced || g?.wo) return a === b ? { key:'score.noDraw' } : null;
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  const r = rule && typeof rule === 'object' ? rule : { pts: rule };
  if ((r.sets ?? cfg.sets)===3) {
    const hi=Math.max(a,b), lo=Math.min(a,b);
    if (hi>2||lo<0) return { key:'score.setsFormat' };
    if (hi!==2) return { key:'score.setsWinner' };
    return null;
  }
  const ptw = r.pts || cfg.pointsToWin||21;
  const hi=Math.max(a,b), lo=Math.min(a,b);
  if (hi===lo) return { key:'score.noDraw' };
  if (hi<ptw) return { key:'score.mustReachEg', params:{ n:ptw, lo } };
  if (hi===ptw && hi-lo<2) return { key:'score.needLead', params:{ n:2 } };
  if (hi>ptw && hi-lo!==2) return { key:'score.exactlyTwoAbove', params:{ n:ptw } };
  return null;
}

// ============ STANDINGS ============
// Normalize name for matching: "תום / מוריאל" ↔ "תום מוריאל" → same key
const normName = s => (s||'').replace(/\s*\/\s*/g,' ').replace(/\s+/g,' ').trim().toLowerCase();

function getStandings(catId, gi) {
  const cs  = state[catId];
  if (!cs) return [];
  const grp = cs.groups[gi];
  const rec = {};
  // Build norm→canonical map so sched entries with different format still match
  const normMap = {};
  grp.teams.forEach(t => {
    rec[t] = {w:0,l:0,pts:0,scored:0,against:0};
    normMap[normName(t)] = t;
  });
  const resolve = s => normMap[normName(s)] || s;
  cs.sched.filter(g=>g.gi===gi).forEach(g => {
    const sa=parseInt(g.sa), sb=parseInt(g.sb);
    if (!isValidScore(sa, sb, catId, getRuleForGame(catId, g, false), g)) return;
    const a=resolve(g.a), b=resolve(g.b);
    if (rec[a]) { rec[a].scored+=sa; rec[a].against+=sb; }
    if (rec[b]) { rec[b].scored+=sb; rec[b].against+=sa; }
    if (sa>sb) {
      if (rec[a]) { rec[a].w++; rec[a].pts+=2; }
      if (rec[b]) { rec[b].l++; rec[b].pts+=1; }
    } else {
      if (rec[b]) { rec[b].w++; rec[b].pts+=2; }
      if (rec[a]) { rec[a].l++; rec[a].pts+=1; }
    }
  });
  return grp.teams.map(t => ({name:t,...rec[t],diff:(rec[t].scored-rec[t].against)}))
    .sort((a,b) => b.pts-a.pts||b.w-a.w||b.diff-a.diff||b.scored-a.scored);
}

function makeStandingsCard(catId, grp, gi, catIdx) {
  const cs  = state[catId];
  const cfg = categories.find(c=>c.id===catId)?.cfg || DEF_CAT_CFG;
  const adv = cfg.advPerGroup||1;
  const st  = getStandings(catId, gi);
  const totalGames = (grp.teams.length*(grp.teams.length-1))/2;
  const played = cs.sched.filter(g=>g.gi===gi && isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false),g)).length;
  const poolDone = played===totalGames && totalGames>0;
  const card = document.createElement('div');
  card.className = 'scard';
  card.dataset.ci = catIdx ?? 0;
  const _grpColor   = grpColors()[gi % 4];
  const _grpOn      = /^#[0-9a-f]{6}$/i.test(_grpColor) ? onColor(_grpColor) : '#fff';
  card.style.setProperty('--cat-color',    _grpColor);
  card.style.setProperty('--cat-on-color', _grpOn);
  const rows = st.map((row,i) => {
    const isWinner = i<adv && poolDone;
    const diff = row.diff||0;
    const diffStr = diff>0?`+${diff}`:String(diff);
    const diffClass = diff>0?'diff-pos':diff<0?'diff-neg':'diff-zero';
    const ti = cs.groups[gi].teams.indexOf(row.name);
    const canEdit = superAdmin;
    const canDelete = superAdmin && (meta.phase === 'registration' || meta.phase === 'built');
    const adminCtrls = canEdit
      ? `<td><button class="gedit-btn" onclick="openEditTeam('${catId}',${gi},${ti})" title="${t('stand.editAria')}" aria-label="${t('stand.editAria')}">✎</button>${
          canDelete?`<button class="team-del" onclick="deleteTeam('${catId}',${gi},${ti})" title="${t('stand.removeAria')}" aria-label="${t('stand.removeAria')}">✕</button>`:''}${
          meta.phase === 'tournament'?`<button class="gedit-btn" onclick="withdrawTeam('${catId}',${gi},${ti})">${t('stand.withdraw')}</button>`:''}</td>` : '';
    return `<tr class="${isWinner?'winner':''}${isMine(row.name)?' is-mine':''}">
      <td><span class="rnk num">#${i+1}</span>${dnH(row.name)}</td>
      <td>${row.w}</td><td>${row.l}</td>
      <td><span class="num">${row.w+row.l}/${grp.teams.length-1}</span></td>
      <td class="${diffClass}"><span class="num">${diff!==0||row.w>0||row.l>0?diffStr:'—'}</span></td>
      <td><span class="pts-val">${row.pts}</span></td>
      ${adminCtrls}
    </tr>`;
  }).join('');
  const adminTh = superAdmin ? '<th></th>' : '';
  card.innerHTML = `<div class="scard-head"><span class="scard-name">${t('stand.group', { name: escH(grp.name) })}</span></div>
    <table class="stbl"><thead><tr><th>${t('stand.col.team')}</th><th>${t('stand.col.w')}</th><th>${t('stand.col.l')}</th><th>${t('stand.col.played')}</th><th>${t('stand.col.diff')}</th><th>${t('stand.col.pts')}</th>${adminTh}</tr></thead>
    <tbody>${rows}</tbody></table>`;
  return card;
}

function renderStandings() {
  const grid = document.getElementById('standings-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const cats = activeCat ? categories.filter(c=>c.id===activeCat) : categories;
  cats.forEach(cat => {
    const cs = state[cat.id];
    if (!cs||!cs.groups.length) return;
    const catIdx = categories.findIndex(c => c.id === cat.id);
    if (cats.length > 1) {
      const hdr = document.createElement('div');
      hdr.className = 'cat-section-header';
      hdr.textContent = cat.name;
      hdr.dataset.ci = catIdx;
      grid.appendChild(hdr);
    }
    const sub = document.createElement('div');
    sub.className = 'stnds-subgrid';
    cs.groups.forEach((grp, gi) => sub.appendChild(makeStandingsCard(cat.id, grp, gi, catIdx)));
    grid.appendChild(sub);
    if (superAdmin && meta.phase !== 'registration') {
      const b = document.createElement('button');
      b.className = 'build-add-pair'; b.textContent = t('stand.addLate');
      b.onclick = () => openLatePair(cat.id);
      grid.appendChild(b);
    }
  });
  if (!grid.children.length) {
    grid.innerHTML = `<div class="empty"><h3>${t('stand.emptyH')}</h3><p>${t('common.buildFirst')}</p></div>`;
  }
}

// ============ EDIT / DELETE TEAMS ============
let editTarget = null;
function openEditTeam(catId, gi, ti) {
  if (!superAdmin) return;
  editTarget = {catId, gi, ti};
  const name = state[catId].groups[gi].teams[ti];
  // Split on '/' or first space
  let p1, p2;
  if (name.includes('/')) {
    [p1, p2] = name.split('/').map(s=>s.trim());
  } else {
    const sp = name.indexOf(' ');
    p1 = sp > 0 ? name.slice(0, sp) : name;
    p2 = sp > 0 ? name.slice(sp + 1) : '';
  }
  document.getElementById('edit-p1').value = p1||'';
  document.getElementById('edit-p2').value = p2||'';
  document.getElementById('edit-modal-title').textContent = t('stand.editTitle', { name: state[catId].groups[gi].name });
  document.getElementById('edit-cat-row')?.classList.add('h');
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}
function closeEdit() {
  document.getElementById('edit-modal').classList.add('h');
  document.getElementById('edit-phone-row')?.classList.add('h');
  editTarget = null;
}
const pairTaken = (catId, name, except) => [...(state[catId]?.roster || []), ...approvedNames(catId)]
  .some(n => normName(n) === normName(name) && normName(n) !== normName(except));

// Rename a pair everywhere in one category; false when it isn't there.
function renamePair(cs, old, name) {
  const is = s => normName(s) === normName(old);
  const before = JSON.stringify(cs);
  cs.roster = cs.roster.map(x => is(x) ? name : x);
  cs.groups.forEach(g => { g.teams = g.teams.map(x => is(x) ? name : x); });
  allGamesOf(cs).forEach(g => { if (is(g.a)) g.a = name; if (is(g.b)) g.b = name; });
  if (JSON.stringify(cs) === before) return false;
}

function openEditReg(id) {
  const r = registrations.find(x => x.id === id);
  if (!admin || !r) return;
  editTarget = { regId: id };
  document.getElementById('edit-p1').value = r.p1 || '';
  document.getElementById('edit-p2').value = r.p2 || '';
  document.getElementById('edit-phone').value = r.phone || '';
  document.getElementById('edit-phone-row').classList.remove('h');
  document.getElementById('edit-modal-title').textContent = t('admin.editReg');
  const catSel = document.getElementById('edit-cat');
  catSel.innerHTML = categories.map(c => `<option value="${escH(c.id)}"${c.id===r.category?' selected':''}>${escH(c.name)}</option>`).join('');
  document.getElementById('edit-cat-row').classList.toggle('h', r.status === 'approved' && meta.phase !== 'registration');
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}

async function saveEditReg(p1, p2) {
  const r = registrations.find(x => x.id === editTarget.regId);
  if (!r) return closeEdit();
  const phoneRaw = document.getElementById('edit-phone').value.trim();
  const phone = phoneRaw ? normPhone(phoneRaw) : '';
  const err = nameError(p1, 'common.player1') || nameError(p2, 'common.player2')
    || (phoneRaw && !phone ? () => t('errors.phoneInvalid') : null);
  if (err) { toast(err()); return; }
  const catId = document.getElementById('edit-cat-row').classList.contains('h') ? r.category : document.getElementById('edit-cat').value || r.category;
  const oldName = regPairName(r), name = `${p1} / ${p2}`;
  if (pairKey(p1, p2) !== pairKey(r.p1, r.p2) || catId !== r.category) {
    if (registrations.some(x => x.id !== r.id && x.status !== 'rejected' && x.category === catId && pairKey(x.p1, x.p2) === pairKey(p1, p2))) {
      toast(t('errors.dupName', { name: fsi(name) })); return;
    }
  }
  if (r.status === 'approved' && (name !== oldName || catId !== r.category)) {
    const moved = catId !== r.category;
    const ok = await commitState(moved ? [r.category, catId] : r.category, () => {
      seedRoster(state[r.category], r.category);
      if (!moved) { renamePair(state[r.category], oldName, name); return; }
      withdrawPair(r.category, state[r.category], oldName);
      seedRoster(state[catId], catId);
      if (!state[catId].roster.some(n => normName(n) === normName(name))) state[catId].roster.push(name);
    });
    if (!ok) return;
  }
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', r.id), secure ? { p1, p2, category: catId } : { p1, p2, phone, category: catId });
    Object.assign(r, { p1, p2, phone, category: catId });
  } catch(e) { alert(t('errors.statusUpdate')); return; }
  closeEdit(); renderRegistrations(); renderBuildPage();
}

async function approveAllShown() {
  if (!admin || meta.phase !== 'registration') return;
  const list = filteredRegs().filter(r => r.status !== 'approved');
  if (!list.length || !await askConfirm(t('admin.confirmApproveAll', { n: list.length }), t('admin.approve'))) return;
  try {
    await Promise.all(list.map(r => updateDoc(doc(db, 'tournaments', tId, 'registrations', r.id), { status: 'approved' })));
  } catch(e) { alert(t('errors.statusUpdate')); return; }
  list.forEach(r => { r.status = 'approved'; });
  await commitState([...new Set(list.map(r => r.category))].filter(id => categories.some(c => c.id === id)),
    () => list.forEach(addRegToRoster));
  renderRegistrations(); renderParticipants(); renderBuildPage();
}

async function saveEdit() {
  if (!admin || !editTarget) return;
  const p1 = cleanName(document.getElementById('edit-p1').value);
  const p2 = cleanName(document.getElementById('edit-p2').value);
  if (editTarget.regId) return saveEditReg(p1, p2);
  const name = p2?`${p1} / ${p2}`:p1;
  if (!name) return;

  // Build page roster edit
  if (editTarget.buildIdx !== undefined) {
    const { catId, oldName } = editTarget;
    const newCatId = document.getElementById('edit-cat')?.value || catId;
    if (newCatId === catId && name === oldName) { closeEdit(); return; }
    if (pairTaken(newCatId, name, newCatId === catId ? oldName : '')) { toast(t('errors.dupName', { name: fsi(name) })); return; }
    const ok = await commitState(newCatId === catId ? catId : [catId, newCatId], () => {
      const src = state[catId];
      seedRoster(src, catId);
      if (!src.roster.some(n => normName(n) === normName(oldName))) return false;
      if (newCatId === catId) return renamePair(src, oldName, name);
      withdrawPair(catId, src, oldName);
      seedRoster(state[newCatId], newCatId);
      state[newCatId].roster.push(name);
    });
    if (!ok) return;
    const reg = registrations.find(r => r.category === catId && normName(regPairName(r)) === normName(oldName));
    if (reg) {
      updateDoc(doc(db,'tournaments',tId,'registrations',reg.id), {category:newCatId, p1, p2});
      reg.category = newCatId; reg.p1 = p1; reg.p2 = p2;
    }
    closeEdit(); renderBuildPage(); renderRegistrations();
    return;
  }

  // Standings group team edit — master only
  if (!superAdmin) return;
  const {catId,gi,ti} = editTarget;
  const old = state[catId]?.groups[gi]?.teams[ti];
  if (!old) return;
  if (name === old) { closeEdit(); return; }
  if (pairTaken(catId, name, old)) { toast(t('errors.dupName', { name: fsi(name) })); return; }
  if (!await commitState(catId, cs => renamePair(cs, old, name))) return;
  const reg = registrations.find(r => r.category === catId && normName(regPairName(r)) === normName(old));
  if (reg) {
    updateDoc(doc(db,'tournaments',tId,'registrations',reg.id), { p1, p2 }).catch(e => console.error(e));
    reg.p1 = p1; reg.p2 = p2;
  }
  closeEdit(); renderStandings(); renderScheduleContent(); renderBracket();
}
// Before the start: the pair leaves its group; only its unplayed games are dropped.
async function deleteTeam(catId, gi, ti) {
  if (!superAdmin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const grp = state[catId]?.groups[gi];
  const name = grp?.teams[ti];
  if (!name) return;
  if (grp.teams.length<=1) { alert(t('errors.groupMin')); return; }
  if (!await askConfirm(t('stand.confirmRemove', { name, group: grp.name }), t('common.remove'))) return;
  if (!await commitState(catId, cs => withdrawPair(catId, cs, name))) return;
  await softRemoveReg(catId, name);
  renderAll();
}

// ============ SCORES ============
// Score inputs call setGS/setKS on every keystroke (commit=false) and again on
// change/blur (commit=true). Saving is per game: each valid game's score is merged
// into the latest server copy of its category in a transaction, so an invalid
// score in one row never blocks the others, and two scorers on the same category
// don't overwrite each other. (sched/ko are arrays in Firestore, so an element
// can't be addressed by a field path — hence read-merge-write.)
const SCORE_DEBOUNCE_MS = 600;
// gk -> {cid, idx, id} | {cid, ri, gi, id} + {sa, sb, base, shown}. `id` = which game it
// was typed into (pair / seeds), `base` = the score it showed before typing.
const unsavedGames = new Map();
let scoreTimer = null, flushing = false;

const gameKey = (cid, idx, ri, gi) => ri == null ? `${cid}-${idx}` : `${cid}-k${ri}-${gi}`;
const gameId = (g, isKO) => isKO ? (g.seedA && g.seedB ? `${g.seedA}|${g.seedB}` : '')
  : g.gi < 0 ? '3P' : pairKey(g.a, g.b);
// The game an unsaved entry belongs to — re-found by pair if the schedule moved under it.
function findGame(cs, e) {
  if (!cs) return null;
  if (e.ri != null) { const g = cs.ko?.[e.ri]?.[e.gi]; return g && gameId(g, true) === e.id ? g : null; }
  const g = cs.sched?.[e.idx];
  return g && gameId(g, false) === e.id ? g : cs.sched?.find(x => gameId(x, false) === e.id) || null;
}
const gameRef = e => findGame(state[e.cid], e);
const sameScore = (g, x) => String(g.sa ?? '') === String(x.sa ?? '') && String(g.sb ?? '') === String(x.sb ?? '');

const UNSAVED_KEY = () => 'luz.unsaved.' + tId;
function mirrorUnsaved() {
  try {
    if (unsavedGames.size) localStorage.setItem(UNSAVED_KEY(), JSON.stringify([...unsavedGames]));
    else localStorage.removeItem(UNSAVED_KEY());
  } catch(_) {}
  setSyncStatus();
}
function restoreUnsaved() {
  try { JSON.parse(localStorage.getItem(UNSAVED_KEY()) || '[]').forEach(([gk, e]) => unsavedGames.set(gk, e)); } catch(_) {}
  applyUnsaved();
}
// Scores typed here but not saved yet win over the remote copy of that game;
// an entry whose game is gone (rebuilt / moved) is dropped.
function applyUnsaved() {
  let lost = 0;
  unsavedGames.forEach((e, gk) => {
    const g = gameRef(e);
    if (!g) { unsavedGames.delete(gk); lost++; return; }
    g.sa = e.sa; g.sb = e.sb;
    const idx = e.ri == null ? state[e.cid].sched.indexOf(g) : e.idx;
    if (idx !== e.idx) { unsavedGames.delete(gk); e.idx = idx; unsavedGames.set(gameKey(e.cid, idx), e); }
  });
  if (lost) { mirrorUnsaved(); toast(t('sync.unsavedDropped')); }
}
// A score with only one side filled is never saved.
const isHalf = g => !String(g.sa ?? '') !== !String(g.sb ?? '');
function scoreMsg(e) {
  const g = gameRef(e);
  if (!g) return '';
  if (isHalf(g)) return t('score.bothSides');
  const err = scoreError(String(g.sa ?? ''), String(g.sb ?? ''), e.cid, getRuleForGame(e.cid, g, e.ri != null), g);
  return err ? t(err.key, err.params) : '';
}
const gameReady = e => !!gameRef(e) && !scoreMsg(e);

function markGameRow(gk) {
  const row = document.getElementById('gc-' + gk);
  if (!row) return;
  const e = unsavedGames.get(gk);
  const msg = e ? scoreMsg(e) : '';
  row.classList.toggle('unsaved', !!e);
  row.classList.toggle('invalid', !!msg && !isHalf(gameRef(e)));
  const err = document.getElementById('serr-' + gk);
  if (err) { const show = !!msg && !!e.shown; err.textContent = show ? msg : ''; err.style.display = show ? 'block' : 'none'; }
}

function scheduleFlush(now) {
  clearTimeout(scoreTimer);
  if (now) flushScoreWrites();
  else scoreTimer = setTimeout(flushScoreWrites, SCORE_DEBOUNCE_MS);
}

async function flushScoreWrites() {
  clearTimeout(scoreTimer); scoreTimer = null;
  if (!firebaseReady || !TREF) return;
  if (flushing) { scoreTimer = setTimeout(flushScoreWrites, SCORE_DEBOUNCE_MS); return; }
  const sent = [...unsavedGames].filter(([, e]) => gameReady(e)).map(([gk, e]) => ({ gk, e, sa: e.sa, sb: e.sb }));
  if (!sent.length) return;
  flushing = true;
  let skipped;
  try {
    await runTransaction(db, async tx => {
      const remote = (await tx.get(TREF)).data()?.state || {};
      const cats = {};
      skipped = [];
      sent.forEach(x => {
        const { e, sa, sb } = x;
        const cs = cats[e.cid] ??= catStateFromFB(structuredClone(remote[e.cid] || catStateToFB(state[e.cid])));
        const g = findGame(cs, e);
        // Someone else saved a different score for this game since we started typing.
        if (!g || (e.base && !sameScore(g, e.base) && !sameScore(g, { sa, sb }))) { skipped.push({ e, g }); return; }
        Object.assign(g, { sa, sb });
        delete g.wo; delete g.forced;
      });
      const args = [];
      Object.entries(cats).forEach(([cid, cs]) => {
        // Re-derive knockout slot names from the merged scores (updateKOForCat reads state[cid]).
        const mine = state[cid];
        state[cid] = cs; updateKOForCat(cid); state[cid] = mine;
        args.push(new FieldPath('state', cid), catStateToFB(cs));
      });
      if (args.length) { args.push('updatedAt', serverTimestamp()); tx.update(TREF, ...args); }
    });
    sent.forEach(({ gk, e, sa, sb }) => {
      const lost = skipped.some(x => x.e === e);
      if (lost || (unsavedGames.get(gk) === e && e.sa === sa && e.sb === sb)) unsavedGames.delete(gk);
      else e.base = { sa, sb };
      markGameRow(gk);
    });
    skipped.forEach(({ e, g }) => { const mine = gameRef(e); if (mine && g) Object.assign(mine, { sa: g.sa, sb: g.sb }); });
    if (skipped.length) { toast(t('sync.conflict')); rerender(); }
    setSyncStatus(true);
    mirrorUnsaved();
  } catch(e) {
    console.error('Score push error', e);
    setSyncStatus(false);
    if (navigator.onLine) scoreTimer = setTimeout(flushScoreWrites, 3000);
  } finally { flushing = false; }
}

function scoreChanged(gk, ref, g, commit) {
  const e = unsavedGames.get(gk) || ref;
  e.sa = g.sa ?? ''; e.sb = g.sb ?? '';
  if (commit) e.shown = true;
  unsavedGames.set(gk, e);
  mirrorUnsaved();
  updateKOForCat(ref.cid);
  markGameRow(gk);
  scheduleFlush(commit);
}

function setGS(catId, idx, k, v, commit) {
  if (!admin || meta.phase !== 'tournament') return;
  const g = state[catId].sched[idx];
  const gk = gameKey(catId, idx);
  const ref = { cid: catId, idx, id: gameId(g, false), base: unsavedGames.has(gk) ? null : { sa: g.sa ?? '', sb: g.sb ?? '' } };
  g[k] = v;
  delete g.wo; delete g.forced;
  scoreChanged(gk, ref, g, commit);
  renderStandings();
}
function setKS(catId, ri, gi, k, v, commit) {
  if (!admin || meta.phase !== 'tournament') return;
  const g = state[catId].ko[ri][gi];
  const gk = gameKey(catId, null, ri, gi);
  const ref = { cid: catId, ri, gi, id: gameId(g, true), base: unsavedGames.has(gk) ? null : { sa: g.sa ?? '', sb: g.sb ?? '' } };
  g[k] = v;
  delete g.wo; delete g.forced;
  g.ri = ri;
  scoreChanged(gk, ref, g, commit);
}

// ============ KO UPDATE ============
function resolvePoolSeed(catId, seed) {
  const cs = state[catId];
  const m  = String(seed||'').match(/^([A-Z])(\d+)$/);
  if (!m) return { label:seed||'TBD', known:false };
  const gi   = m[1].charCodeAt(0)-65;
  const rank = parseInt(m[2],10);
  if (gi<0||gi>=cs.groups.length) return { label:seed, known:false };
  const grp = cs.groups[gi];
  const totalGames = (grp.teams.length*(grp.teams.length-1))/2;
  const done = cs.sched.filter(g=>g.gi===gi&&isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false),g)).length;
  if (done!==totalGames) return { label:seed, known:false };
  const st = getStandings(catId, gi);
  if (!st[rank-1]) return { label:seed, known:false };
  return { label:st[rank-1].name, known:true };
}

function getKOLoser(game, catId) {
  if (!game || game.isBye) return null;
  const sa=parseInt(game.sa), sb=parseInt(game.sb);
  if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true),game)) return sa>sb ? game.b : game.a;
  return null;
}

function getKOWinner(game, catId) {
  if (!game) return null;
  if (game.isBye) {
    const seed = game.seedA || game.a;
    if (!seed) return null;
    // Return resolved team name if known, otherwise return seed code (e.g. "A1")
    if (/^[A-Z]\d+$/.test(seed)) { const r=resolvePoolSeed(catId,seed); return r.known?r.label:seed; }
    return seed;
  }
  const sa=parseInt(game.sa), sb=parseInt(game.sb);
  if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true),game)) return sa>sb?game.a:game.b;
  return null;
}

function updateKOForCat(catId) {
  const cs = state[catId];
  if (!cs||!cs.ko.length) return;

  // Stamp each KO game with its round index so per-stage scoring rules resolve correctly
  cs.ko.forEach((round, ri) => round.forEach(g => { if (g) g.ri = ri; }));

  // r0: resolve pool seeds; byes just resolve their single seed
  if (cs.ko[0]) {
    cs.ko[0].forEach(g => {
      if (String(g.sa ?? '') !== '' || String(g.sb ?? '') !== '') return;
      const seedA = g.seedA || (g.isBye ? g.a : '');
      const seedB = g.seedB || '';
      if (seedA) { const r=resolvePoolSeed(catId,seedA); if(r.known||/^[A-Z]\d+$/.test(seedA)) g.a=r.known?r.label:seedA; }
      if (seedB) { const r=resolvePoolSeed(catId,seedB); if(r.known||/^[A-Z]\d+$/.test(seedB)) g.b=r.known?r.label:seedB; }
    });
  }

  for (let ri=1; ri<cs.ko.length; ri++) {
    const prev = cs.ko[ri-1];
    const rndName = getKORoundName(catId, ri-1);
    // Cross pairing when 4 QF games reduce to 2 SF games (QF1×QF4, QF2×QF3)
    const isCross = prev.length === 4 && cs.ko[ri].filter(g=>!g.isThirdPlace).length === 2;
    cs.ko[ri].forEach((g, gi) => {
      if (g.isThirdPlace || String(g.sa ?? '') !== '' || String(g.sb ?? '') !== '') return;
      const idxA = isCross ? gi               : gi*2;
      const idxB = isCross ? prev.length-1-gi : gi*2+1;
      const seedLabel = src => {
        if (!src) return null;
        if (src.seedA && src.seedB && !src.isBye) return `${src.seedA}/${src.seedB}`;
        return null;
      };
      const wa = getKOWinner(prev[idxA], catId);
      const wb = getKOWinner(prev[idxB], catId);
      g.a = wa || seedLabel(prev[idxA]) || `Winner of ${rndName} ${idxA+1}`;
      g.b = wb || seedLabel(prev[idxB]) || `Winner of ${rndName} ${idxB+1}`;
    });
  }

  // Auto-fill 3rd-place game with SF losers
  if (cs.ko.length >= 2) {
    const sfRound = cs.ko[cs.ko.length - 2];
    const thirdGame = cs.sched.find(g => g.isThirdPlace);
    if (thirdGame && sfRound && String(thirdGame.sa ?? '') === '' && String(thirdGame.sb ?? '') === '') {
      thirdGame.a = getKOLoser(sfRound[0], catId) || 'Loser of SF1';
      thirdGame.b = getKOLoser(sfRound[1], catId) || 'Loser of SF2';
    }
  }
}

function koGameLabel(catId, ri, gi) {
  const cs = state[catId];
  if (!cs?.ko?.[ri]) return '';
  const round = cs.ko[ri];
  if (round[gi]?.isBye) return '';
  const fromEnd = cs.ko.length - 1 - ri;
  const num = round.slice(0, gi).filter(g => !g.isBye).length + 1;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return `SF${num}`;
  if (fromEnd === 2) return `QF${num}`;
  if (fromEnd === 3) return `R16-${num}`;
  return `G${num}`;
}

// Display text for koGameLabel()'s 'Final' / 'SF2' / 'QF3' / 'R16-2' / 'G1'.
function tGameLbl(s) {
  const m = /^(Final|SF|QF|R16-|G)(\d*)$/.exec(s);
  return m ? t('bracket.lbl.' + { Final:'final', SF:'sf', QF:'qf', 'R16-':'r16', G:'game' }[m[1]], { n: m[2] }) : s;
}

// ============ SCHEDULE PAGE ============
function renderStats() {
  const el = document.getElementById('sbar');
  if (!el) return;
  const cats = activeCat ? categories.filter(c=>c.id===activeCat) : categories;
  let totalPool=0, donePool=0, totalKO=0, lastTime='08:00', lastDur=30;
  cats.forEach(cat => {
    const cs = state[cat.id];
    if (!cs) return;
    const poolG = cs.sched.filter(g=>g.gi>=0);          // real pool games
    const thirdG = cs.sched.filter(g=>g.gi===-1);       // 3rd-place game lives in sched
    totalPool += poolG.length;
    donePool  += poolG.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),cat.id,getRuleForGame(cat.id,g,false),g)).length;
    totalKO   += cs.ko.reduce((s,r)=>s+r.filter(g=>!g.isBye).length, 0) + thirdG.length;
    allGamesOf(cs).forEach(g => { if (g.time && t2m(g.time) > t2m(lastTime)) { lastTime = g.time; lastDur = cat.cfg?.gameDur||30; } });
  });
  if (!totalPool) { el.innerHTML=''; return; }
  // "Scheduled end", not "Est. End": this is the last game's planned slot, so it
  // does NOT move when the evening runs late. Calling it an estimate would lie
  // exactly when people care most.
  el.innerHTML = `
    <div class="sc"><div class="sl">${t('sched.statPool')}</div><div class="sv">${donePool}/${totalPool}</div></div>
    <div class="sc"><div class="sl">${t('sched.statKO')}</div><div class="sv">${totalKO}</div></div>
    <div class="sc"><div class="sl">${t('sched.statEnd')}</div><div class="sv a">${addM(lastTime,lastDur)}</div></div>`;
}

// Per court, across all categories: the first unscored game is on court, the one after it is next.
// Returns { marks: Map(gameKey → 'now'|'next'), now: [{time, dur}] }.
function liveState() {
  const marks = new Map(), now = [];
  if (meta.phase !== 'tournament') return { marks, now };
  const byCourt = {};
  categories.forEach(cat => {
    const cs = state[cat.id];
    if (!cs) return;
    const add = (g, isKO, gk) => {
      if (!g.court || !g.time || isValidScore(parseInt(g.sa), parseInt(g.sb), cat.id, getRuleForGame(cat.id, g, isKO), g)) return;
      (byCourt[g.court] ||= []).push({ gk, time: g.time, dur: getRuleForGame(cat.id, g, isKO).dur || cat.cfg?.gameDur || 25 });
    };
    cs.sched.forEach((g, i) => add(g, false, gameKey(cat.id, i)));
    cs.ko.forEach((r, ri) => r.forEach((g, gi) => { if (!g.isBye) add({ ...g, ri }, true, gameKey(cat.id, null, ri, gi)); }));
  });
  Object.values(byCourt).forEach(list => {
    list.sort((a, b) => t2m(a.time) - t2m(b.time));
    if (list[0]) { marks.set(list[0].gk, 'now'); now.push(list[0]); }
    if (list[1]) marks.set(list[1].gk, 'next');
  });
  return { marks, now };
}

// Median minutes the on-court games are past their planned end; shown only on the event day.
function renderLateBanner() {
  const el = document.getElementById('late-banner');
  if (!el) return;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const d = meta.eventDate === new Date().toLocaleDateString('sv-SE')
    ? liveState().now.map(g => nowM - t2m(g.time) - g.dur).sort((a, b) => a - b) : [];
  const med = d.length ? d[Math.floor((d.length - 1) / 2)] : 0;
  el.classList.toggle('h', med <= 5);
  el.textContent = med > 5 ? t('live.late', { n: med }) : '';
}
setInterval(renderLateBanner, 60000);

function buildGameRow(catId, g, idx, isKO, live) {
  const rule = getRuleForGame(catId, g, isKO);
  const done = isValidScore(parseInt(g.sa), parseInt(g.sb), catId, rule, g);
  // Color pill by group index for pool; by court→group for KO (dynamic group colors).
  // The 3rd-place game lives in sched with gi === -1, which produced the
  // non-existent class "gi-1" and left its court pill unpainted — colour it by
  // court like the other knockout games.
  const pc = `gi${(isKO || (g.gi ?? 0) < 0) ? (g.court-1)%4 : g.gi % 4}`;
  const wrap = document.createElement('div');
  const row  = document.createElement('div');
  const koLbl = isKO ? tGameLbl(koGameLabel(catId, g.ri, g.gi)) : '';
  const gk = isKO ? gameKey(catId, null, g.ri, g.gi) : gameKey(catId, idx);
  const unsaved = unsavedGames.get(gk);
  const msg = unsaved ? scoreMsg(unsaved) : '';
  row.id = 'gc-' + gk;
  row.className = 'gc'+(done?' done':'')+(isKO?' ko-game':'')+(unsaved?' unsaved':'')+(msg && !isHalf(g)?' invalid':'')+(live==='now'?' is-now':'');
  const setter = k => isKO ? `setKS('${catId}',${g.ri},${g.gi},'${k}',this.value` : `setGS('${catId}',${idx},'${k}',this.value`;
  // Stable ids let the focus-preserving re-render put the caret back.
  const sid = k => isKO ? `si-${catId}-k${g.ri}-${g.gi}-${k}` : `si-${catId}-${idx}-${k}`;
  const gtag = (!isKO&&g.gn?`<span class="gtag">${escH(g.gn)}</span>`:'')
    + (superAdmin && g.manual ? `<span class="tag-manual" title="${t('game.tagManualTitle')}">${t('game.tagManual')}</span>` : '')
    + (g.wo ? `<span class="tag-wo">${t('game.tagWo')}</span>` : g.forced ? `<span class="tag-forced">${t('game.tagForced')}</span>` : '')
    + (live ? `<span class="live-badge live-${live}">${t('live.' + live)}</span>` : '');
  const court = t('sched.courtShort', { n: g.court || '—' });
  const pill = (superAdmin && meta.phase !== 'registration'
    ? `<button type="button" class="pill ${pc}" onclick="openGameSheet('${catId}',${isKO ? `null,${g.ri},${g.gi}` : idx})" aria-label="${t('move.aria')}">${court} ⇄</button>`
    : `<span class="pill ${pc}">${court}</span>`) + (koLbl?`<span class="ko-lbl">${koLbl}</span>`:'');
  if (admin && meta.phase === 'tournament') {
    // Each input sits next to its own team; on a phone the row stacks as "team – score".
    const bo3 = (rule.sets ?? categories.find(c => c.id === catId)?.cfg?.sets) === 3;
    const inp = (k, team) => `<input class="si" id="${sid(k)}" type="number" min="0"${bo3 ? ' max="2"' : ''} inputmode="numeric" placeholder="—"
      aria-label="${escH(t('sched.scoreFor', { team: dn(tSlot(team)) }))}" value="${escH(String(g[k] ?? ''))}"
      oninput="${setter(k)})" onchange="${setter(k)},true)"/>`;
    row.classList.add('edit');
    row.innerHTML = `${pill}
      <span class="gside a"><span class="gt">${dnH(tSlot(g.a))}${gtag}</span>${inp('sa', g.a)}</span>
      <span class="gvs">${t('sched.vs')}</span>
      <span class="gside b">${inp('sb', g.b)}<span class="gt r">${dnH(tSlot(g.b))}</span></span>`;
  } else {
    row.innerHTML = `${pill}
      <span class="gt">${dnH(tSlot(g.a))}${gtag}</span>
      <span class="gvs">${t('sched.vs')}</span>
      <span class="gt r">${dnH(tSlot(g.b))}</span>
      <span class="sw"><span class="ssep">${done?`${g.sa} : ${g.sb}`:'— : —'}</span></span>`;
  }
  const errD  = document.createElement('div');
  errD.id = 'serr-' + gk; errD.className = 'score-err';
  errD.setAttribute('role', 'status'); errD.setAttribute('aria-live', 'polite');
  const showErr = !!msg && !!unsaved.shown;
  errD.textContent = showErr ? msg : ''; errD.style.display = showErr ? 'block' : 'none';
  wrap.appendChild(row); wrap.appendChild(errD);
  return wrap;
}

function renderScheduleContent() {
  const el = document.getElementById('schedule-content');
  if (!el) return;
  const cats = activeCat ? categories.filter(c=>c.id===activeCat) : categories;
  cats.forEach(cat => { if (state[cat.id]) updateKOForCat(cat.id); });
  const hasAny = cats.some(cat => (state[cat.id]?.sched||[]).length>0);
  if (!hasAny) {
    el.innerHTML = `<div class="empty"><h3>${t('sched.emptyH')}</h3><p>${t('common.buildFirst')}</p></div>`;
    return;
  }
  const allGames = [];
  cats.forEach(cat => {
    const cs = state[cat.id];
    if (!cs) return;
    cs.sched.filter(g => activeCourt==='all'||g.court===activeCourt)
      .forEach(g => allGames.push({...g,_catId:cat.id,_idx:cs.sched.indexOf(g),_isKO:false,_rn:null}));
    cs.ko.flatMap((r,ri)=>r.map((g,gi)=>({...g,ri,gi})))
      .filter(g=>!g.isBye && (activeCourt==='all'||g.court===activeCourt))
      .forEach(g=>allGames.push({...g,_catId:cat.id,_idx:-1,_isKO:true,_rn:getKORoundName(cat.id,g.ri),_fe:cs.ko.length-1-g.ri}));
  });
  if (!allGames.length) { el.innerHTML=`<div class="empty"><h3>${t('sched.noGames')}</h3></div>`; return; }

  const inp = document.getElementById('sched-search');
  const q   = (inp?.value||'').trim().toLowerCase();
  const filtered = q
    ? allGames.filter(g => g.a.toLowerCase().includes(q)||g.b.toLowerCase().includes(q))
    : allGames;
  if (q && !filtered.length) {
    el.innerHTML=`<div class="empty"><h3>${t('sched.noMatch', { q: escH(q) })}</h3></div>`; return;
  }

  const live = liveState().marks;
  renderLateBanner();
  const byTime = {};
  filtered.filter(g => g.time).forEach(g => { const k=g.time; if(!byTime[k])byTime[k]=[]; byTime[k].push(g); });
  el.innerHTML = '';
  const unsched = filtered.filter(g => !g.time);
  if (unsched.length) {
    const ub = document.createElement('div');
    ub.className = 'unsched-block';
    ub.innerHTML = `<h4>${t('sched.unscheduled')}</h4><p>${t('sched.unscheduledHint')}</p>`;
    unsched.forEach(g => ub.appendChild(buildGameRow(g._catId, g, g._idx, g._isKO)));
    el.appendChild(ub);
  }
  // Global breaks (e.g. Friday-dinner) shown as their own marker block, in time order.
  const brs = (meta.breaks||[]).map(b=>({at:t2m(b.atTime), min:b.minutes||0, done:false})).sort((a,b)=>a.at-b.at);
  const dinnerNote = meta.dinnerBreakNote || t('sched.breakDefault');
  Object.keys(byTime).sort((a,b)=>t2m(a)-t2m(b)).forEach(time => {
    brs.forEach(b=>{ if(!b.done && t2m(time) >= b.at){ b.done=true;
      const bl=document.createElement('div'); bl.className='tblock';
      bl.innerHTML=`<div class="thdr"><span class="tlbl">${m2t(b.at)}</span><div class="tline"></div></div>`+
        `<div style="margin:6px 0 2px;padding:11px 14px;border:1.5px dashed var(--primary,#652d92);border-radius:12px;`+
        `background:color-mix(in srgb,var(--primary,#652d92) 7%,transparent);font-weight:600;color:var(--primary,#652d92);display:flex;gap:8px;align-items:center">`+
        `<span class="ic ic-meal" aria-hidden="true"></span><span>${t('sched.breakLine', { note: escH(dinnerNote), min: b.min,
          from: `<span class="num">${m2t(b.at)}</span>`, to: `<span class="num">${m2t(b.at+b.min)}</span>` })}</span></div>`;
      el.appendChild(bl);
    }});
    const games = byTime[time];
    const block = document.createElement('div');
    block.className='tblock';
    // Build sub-groups: key = catId + type
    const subGroups = new Map();
    games.forEach(g => {
      const isThirdPlace = !g._isKO && g.gi === -1;
      let key, label;
      const catName = categories.find(c=>c.id===g._catId)?.name || '';
      const stage = g._isKO ? tRound(g._fe) : t(isThirdPlace ? 'sched.third' : 'sched.pools');
      if (g._isKO) key = `ko-${g._catId}-${g._rn}`;
      else if (isThirdPlace) key = `3p-${g._catId}`;
      else key = `pool-${g._catId}`;
      label = catName ? t('sched.subLabel', { cat: `\u2068${catName}\u2069`, stage }) : stage;
      if (!subGroups.has(key)) subGroups.set(key, {label, games:[]});
      subGroups.get(key).games.push(g);
    });
    const needSubHeaders = subGroups.size > 1 || [...subGroups.values()].some(s=>s.label);
    block.innerHTML=`<div class="thdr"><span class="tlbl">${time}</span><div class="tline"></div>${superAdmin && meta.phase !== 'registration'
      ? `<button type="button" class="gact" onclick="openDelay('${time}')" aria-label="${escH(t('delay.aria', { time }))}"><span class="ic ic-clock"></span></button>` : ''}</div>`;
    subGroups.forEach(({label, games: sg}) => {
      if (needSubHeaders && label) {
        const sh = document.createElement('div');
        sh.className = 'tsub-hdr';
        const firstG = sg[0];
        const r = getRuleForGame(firstG._catId, firstG, firstG._isKO);
        const ruleStr = (meta.sport === 'volleyball') ? '' : (r.change ? t('sched.ruleSwitch', { pts: r.pts, change: r.change }) : t('sched.rule', { pts: r.pts }));
        sh.textContent = label + ruleStr;
        block.appendChild(sh);
      }
      sg.forEach(g => block.appendChild(buildGameRow(g._catId, g, g._idx, g._isKO,
        live.get(g._isKO ? gameKey(g._catId, null, g.ri, g.gi) : gameKey(g._catId, g._idx)))));
    });
    if (block.querySelector('.gc:not(.done)')) block.classList.add('has-open');
    el.appendChild(block);
  });
}

// "My pair": the schedule search, remembered per tournament and highlighted in standings and bracket.
const ME_KEY = () => 'luz.me.' + tId;
let myPairQ = '';
try { myPairQ = localStorage.getItem(ME_KEY()) || ''; } catch(_) {}
const isMine = name => myPairQ.trim().length >= 2 && String(name || '').toLowerCase().includes(myPairQ.trim().toLowerCase());
function filterSchedule() {
  myPairQ = document.getElementById('sched-search')?.value || '';
  try { localStorage.setItem(ME_KEY(), myPairQ); } catch(_) {}
  renderScheduleContent();
}

// ============ LIVE OPS (master) ============
const isSlot = s => !s || /^(TBD$|BYE$|Winner of |Loser of |[A-Z]\d+(\/[A-Z]\d+)?$)/.test(s);
const playersOf = g => [g.a, g.b].filter(s => !isSlot(s)).flatMap(s => s.split('/').map(normName));
function liveGames() {
  return categories.flatMap(c => {
    const cs = state[c.id];
    if (!cs) return [];
    return [...cs.sched.map((g, idx) => ({ cid: c.id, g, idx, id: gameId(g, false) })),
      ...cs.ko.flatMap((r, ri) => r.map((g, gi) => ({ cid: c.id, g, ri, gi, id: gameId(g, true) }))).filter(x => !x.g.isBye)];
  });
}
const gameDurOf = x => getRuleForGame(x.cid, x.g, x.ri != null).dur || categories.find(c => c.id === x.cid)?.cfg?.gameDur || 30;
// Games overlapping x if it were played at court/time: same court, or a shared player.
function clashesAt(x, court, time, skip = []) {
  const s = t2m(time), e = s + gameDurOf(x), pl = playersOf(x.g);
  return liveGames().filter(y => y.g !== x.g && !skip.includes(y.g) && y.g.time
    && t2m(y.g.time) < e && s < t2m(y.g.time) + gameDurOf(y)
    && (+y.g.court === +court || playersOf(y.g).some(p => pl.includes(p))));
}

function openSheet(html) {
  const m = document.getElementById('sheet-modal');
  document.getElementById('sheet-body').innerHTML = html;
  m.classList.remove('h');
  m.onkeydown = e => { if (e.key === 'Escape') closeSheet(); };
  m.querySelector('input,select,button')?.focus();
}
function closeSheet() { document.getElementById('sheet-modal')?.classList.add('h'); }

let sheetRef = null;   // {cid, idx | ri+gi, id} of the game the sheet is about
function openGameSheet(cid, idx, ri, gi) {
  if (!superAdmin) return;
  const x = liveGames().find(y => y.cid === cid && (ri == null ? y.idx === idx : y.ri === ri && y.gi === gi));
  if (!x) return;
  sheetRef = { cid, idx: x.idx, ri: x.ri, gi: x.gi, id: x.id };
  const g = x.g, scored = hasScore(g);
  const courts = Math.max(coordBuild() ? coordCfg().COURTS : categories.find(c => c.id === cid)?.cfg?.courts || 2, +g.court || 0);
  openSheet(`<h3 id="sheet-title">${t('move.title')}</h3>
    <p class="sheet-sub">${dnH(tSlot(g.a))} ${t('sched.vs')} ${dnH(tSlot(g.b))}</p>
    ${scored ? `<p class="sheet-msg warn">${t('move.scored')}</p>` : `<div class="sheet-grid">
      <label>${t('move.court')}<select id="mv-court">${Array.from({ length: courts }, (_, i) =>
        `<option value="${i+1}"${+g.court === i+1 ? ' selected' : ''}>${i+1}</option>`).join('')}</select></label>
      <label>${t('move.time')}<input id="mv-time" type="time" value="${escH(g.time || '')}"/></label>
    </div>`}
    <p class="sheet-msg err" id="mv-msg" role="alert"></p>
    <div class="modal-btns">
      ${scored ? '' : `<button class="mbtn mbtn-ok" onclick="saveMove()">${t('move.save')}</button>`}
      <button class="mbtn mbtn-cancel" onclick="closeSheet()">${t('common.cancel')}</button>
    </div>
    <div class="sheet-links">
      ${['a', 'b'].filter(k => !isSlot(g[k])).map(k => `<button type="button" onclick="editPairFromSheet('${k}')">✎ ${dnH(g[k])}</button>`).join('')}
      ${meta.phase === 'tournament' && !scored && !isSlot(g.a) && !isSlot(g.b) ? ['a', 'b'].map(k =>
        `<button type="button" class="danger-link" onclick="techLoss('${k}')">${t('game.wo')}: ${dnH(g[k])}</button>`).join('') : ''}
      ${meta.phase === 'tournament' && String(g.sa ?? '') !== '' && String(g.sb ?? '') !== '' && +g.sa !== +g.sb && !g.forced
        ? `<button type="button" onclick="forceSave()">${t('game.forced')} ${escH(g.sa)}:${escH(g.sb)}</button>` : ''}
    </div>`);
}

// Volleylab rules: a technical loss is recorded as pointsToWin : 12 (2:0 in a best-of-3 stage).
function woScore(cid, g, isKO) {
  const r = getRuleForGame(cid, g, isKO), cfg = categories.find(c => c.id === cid)?.cfg || DEF_CAT_CFG;
  return (r.sets ?? cfg.sets) === 3 ? [2, 0] : [r.pts || cfg.pointsToWin || 21, 12];
}
const dropUnsaved = r => { unsavedGames.delete(r.ri == null ? gameKey(r.cid, r.idx) : gameKey(r.cid, null, r.ri, r.gi)); mirrorUnsaved(); };

async function techLoss(k) {
  const r = sheetRef, g = r && gameRef(r);
  if (!superAdmin || !g || hasScore(g)) return;
  const [w, l] = woScore(r.cid, g, r.ri != null);
  const score = k === 'a' ? `${l}:${w}` : `${w}:${l}`;
  if (!await askConfirm(t('game.confirmWo', { name: dn(g[k]), score }), t('game.wo'))) return;
  const ok = await commitState(r.cid, () => {
    const x = gameRef(r);
    if (!x || hasScore(x)) return false;
    [x.sa, x.sb] = k === 'a' ? [l, w] : [w, l];
    x.wo = true;
    updateKOForCat(r.cid);
  });
  if (!ok) return;
  dropUnsaved(r); closeSheet(); rerender();
}

async function forceSave() {
  const r = sheetRef, g = r && gameRef(r);
  if (!superAdmin || !g) return;
  const sa = parseInt(g.sa), sb = parseInt(g.sb);
  if (isNaN(sa) || isNaN(sb) || sa === sb || sa < 0 || sb < 0) return;
  if (!await askConfirm(t('game.confirmForced', { sa, sb }), t('game.forced'))) return;
  const ok = await commitState(r.cid, () => {
    const x = gameRef(r);
    if (!x) return false;
    Object.assign(x, { sa, sb, forced: true });
    delete x.wo;
    updateKOForCat(r.cid);
  });
  if (!ok) return;
  dropUnsaved(r); closeSheet(); rerender();
}

// The pair stays in the table; every unscored game of theirs becomes a technical loss.
async function withdrawTeam(catId, gi, ti) {
  const name = state[catId]?.groups[gi]?.teams[ti];
  if (!superAdmin || meta.phase !== 'tournament' || !name) return;
  if (!await askConfirm(t('stand.confirmWithdraw', { name: dn(name) }), t('stand.withdraw'))) return;
  const is = s => normName(s) === normName(name);
  const ok = await commitState(catId, cs => {
    let n = 0;
    cs.sched.forEach(g => {
      if (hasScore(g) || !(is(g.a) || is(g.b)) || isSlot(g.a) || isSlot(g.b)) return;
      const [w, l] = woScore(catId, g, false);
      [g.sa, g.sb] = is(g.a) ? [l, w] : [w, l];
      g.wo = true; n++;
    });
    cs.ko.forEach(rd => rd.forEach(g => {
      if (g.isBye || hasScore(g) || !(is(g.a) || is(g.b)) || isSlot(g.a) || isSlot(g.b)) return;
      const [w, l] = woScore(catId, g, true);
      [g.sa, g.sb] = is(g.a) ? [l, w] : [w, l];
      g.wo = true; n++;
    }));
    if (!n) return false;
    updateKOForCat(catId);
  });
  if (ok) renderAll();
}

async function saveMove() {
  const r = sheetRef, g = r && gameRef(r), msg = document.getElementById('mv-msg');
  if (!g) return closeSheet();
  if (hasScore(g)) { msg.textContent = t('move.scored'); return; }
  const court = +document.getElementById('mv-court').value, time = document.getElementById('mv-time').value;
  if (!time) return;
  const hits = clashesAt({ ...r, g }, court, time);
  const y = hits[0];
  const swap = hits.length === 1 && +y.g.court === court && y.g.time === time && !hasScore(y.g) ? y : null;
  if (hits.length && !swap) {
    const c = hits.find(h => +h.g.court === court);
    if (c) { msg.textContent = t('move.collision', { court, time: c.g.time }); return; }
    const p = [g.a, g.b].find(s => !isSlot(s) && s.split('/').map(normName).some(n => playersOf(y.g).includes(n)));
    msg.textContent = t('move.collisionPlayer', { name: dn(p || ''), time: y.g.time });
    return;
  }
  if (swap && g.time && clashesAt(swap, g.court, g.time, [g]).length) { msg.textContent = t('move.collision', { court: g.court, time: g.time }); return; }
  if (swap && !await askConfirm(t('move.swapQ', { game: `${dn(tSlot(y.g.a))} – ${dn(tSlot(y.g.b))}` }), t('move.swap'))) return;
  const sr = swap && { cid: y.cid, idx: y.idx, ri: y.ri, gi: y.gi, id: y.id };
  const ok = await commitState([...new Set([r.cid, sr && sr.cid].filter(Boolean))], () => {
    const a = gameRef(r), b = sr && gameRef(sr);
    if (!a || hasScore(a) || (sr && (!b || hasScore(b)))) return false;
    const from = { court: a.court, time: a.time };
    Object.assign(a, { court, time, manual: true });
    if (b) Object.assign(b, from, { manual: true });
  });
  if (!ok) return;
  closeSheet();
  toast(t(sr ? 'move.swapped' : 'move.moved'));
  rerender();
}

// Late pair after the build: joins a group, its games go into free court/time slots
// (never before the last scored game); what doesn't fit stays unscheduled for ⇄.
function openLatePair(cid) {
  const cs = state[cid];
  if (!superAdmin || !cs?.groups.length) return;
  const small = cs.groups.reduce((m, g, i) => g.teams.length < cs.groups[m].teams.length ? i : m, 0);
  openSheet(`<h3 id="sheet-title">${t('late.title')} · <bdi>${escH(categories.find(c => c.id === cid)?.name || '')}</bdi></h3>
    <div class="sheet-grid">
      <label>${t('common.player1')}<input id="lp-p1" dir="auto" list="player-datalist" autocomplete="off"/></label>
      <label>${t('common.player2')}<input id="lp-p2" dir="auto" list="player-datalist" autocomplete="off"/></label>
      <label>${t('late.group')}<select id="lp-group">${cs.groups.map((g, i) =>
        `<option value="${i}"${i === small ? ' selected' : ''}>${escH(g.name)} (${g.teams.length})</option>`).join('')}</select></label>
    </div>
    <details><summary>${t('late.bulk')}</summary><textarea id="lp-bulk" class="bulk-input" dir="auto" placeholder="${t('late.bulkPh')}"></textarea></details>
    <p class="sheet-msg err" id="lp-msg" role="alert"></p>
    <div class="modal-btns">
      <button class="mbtn mbtn-ok" onclick="saveLatePair('${cid}')">${t('common.add')}</button>
      <button class="mbtn mbtn-cancel" onclick="closeSheet()">${t('common.cancel')}</button>
    </div>`);
}

function placeLateGames(cid, games) {
  const all = liveGames(), courts = coordBuild() ? coordCfg().COURTS : categories.find(c => c.id === cid)?.cfg?.courts || 2;
  const floor = Math.max(0, ...all.filter(x => hasScore(x.g) && x.g.time).map(x => t2m(x.g.time)));
  const times = [...new Set(all.map(x => x.g.time).filter(s => s && t2m(s) >= floor))].sort((a, b) => t2m(a) - t2m(b));
  let unplaced = 0;
  games.forEach(g => {
    const x = { cid, g };
    const slot = times.flatMap(time => Array.from({ length: courts }, (_, i) => [i + 1, time]))
      .find(([court, time]) => !clashesAt(x, court, time).length);
    if (slot) [g.court, g.time] = slot; else unplaced++;
  });
  return unplaced;
}

async function saveLatePair(cid) {
  const msg = document.getElementById('lp-msg');
  const bulk = document.getElementById('lp-bulk').value.split('\n').map(cleanName).filter(Boolean);
  const one = [cleanName(document.getElementById('lp-p1').value), cleanName(document.getElementById('lp-p2').value)];
  let pairs;
  if (bulk.length) {
    const bad = bulk.findIndex(l => l.split('/').length !== 2 || l.split('/').some(s => !cleanName(s)));
    if (bad >= 0) { msg.textContent = t('late.badLine', { n: bad + 1 }); return; }
    pairs = bulk.map(l => l.split('/').map(cleanName));
  } else pairs = [one];
  for (const [p1, p2] of pairs) {
    const err = nameError(p1, 'common.player1') || nameError(p2, 'common.player2');
    if (err) { msg.textContent = err(); return; }
  }
  const names = pairs.map(([p1, p2]) => `${p1} / ${p2}`);
  const dup = names.find((n, i) => pairTaken(cid, n) || names.findIndex(m => normName(m) === normName(n)) !== i);
  if (dup) { msg.textContent = t('errors.dupName', { name: dn(dup) }); return; }
  const pick = bulk.length ? null : +document.getElementById('lp-group').value;
  let unplaced = 0;
  const ok = await commitState(cid, cs => {
    if (!cs.groups.length || names.some(n => cs.roster.some(m => normName(m) === normName(n)))) return false;
    unplaced = 0;
    names.forEach(name => {
      const gi = pick ?? cs.groups.reduce((m, g, i) => g.teams.length < cs.groups[m].teams.length ? i : m, 0);
      const grp = cs.groups[gi];
      const games = grp.teams.map(b => ({ catId: cid, gi, gn: grp.name, a: name, b, sa: '', sb: '', court: '', time: '' }));
      grp.teams.push(name);
      cs.roster.push(name);
      cs.sched.push(...games);
      unplaced += placeLateGames(cid, games);
    });
    updateKOForCat(cid);
  });
  if (!ok) return;
  for (const [p1, p2] of pairs) {
    try { await addDoc(REGS_REF, { p1, p2, phone: '', category: cid, status: 'approved', paid: false, createdAt: serverTimestamp() }); } catch(e) { console.error(e); }
    addPlayerToDB(p1, ''); addPlayerToDB(p2, '');
  }
  closeSheet();
  toast(t('late.added', { n: names.length }) + (unplaced ? ' · ' + t('late.unplaced', { n: unplaced }) : ''));
  renderAll();
}

function openDelay(time) {
  if (!superAdmin) return;
  openSheet(`<h3 id="sheet-title">${t('delay.title', { time })}</h3>
    <p class="sheet-sub">${t('delay.desc')}</p>
    <div class="sheet-chips">${[-10, 5, 10, 15].map(d =>
      `<button type="button" onclick="shiftFrom('${time}',${d})">${d > 0 ? '+' : '−'}${t('delay.min', { d: Math.abs(d) })}</button>`).join('')}</div>
    <div class="modal-btns"><button class="mbtn mbtn-cancel" onclick="closeSheet()">${t('common.cancel')}</button></div>`);
}

// Shift every unscored game at/after `time` (current category + court filter) by d minutes.
// A pair with a scored game in the shifted window, or one playing right now, keeps its games.
async function shiftFrom(time, d) {
  const from = t2m(time), now = new Date(), nowM = now.getHours() * 60 + now.getMinutes();
  const inView = x => (!activeCat || x.cid === activeCat) && (activeCourt === 'all' || x.g.court === activeCourt);
  const pick = () => {
    const all = liveGames().filter(x => x.g.time && t2m(x.g.time) >= Math.min(from, from + d));
    const busy = new Set(all.filter(x => hasScore(x.g) || (t2m(x.g.time) <= nowM && nowM < t2m(x.g.time) + gameDurOf(x)))
      .flatMap(x => playersOf(x.g)));
    const cand = all.filter(x => inView(x) && t2m(x.g.time) >= from && !hasScore(x.g));
    const moved = cand.filter(x => !playersOf(x.g).some(p => busy.has(p)));
    return { moved, skipped: cand.length - moved.length };
  };
  const { moved, skipped } = pick();
  if (!moved.length) { toast(t('delay.none')); return; }
  const cids = [...new Set(moved.map(x => x.cid))];
  let res;
  const ok = await commitState(cids, () => {
    res = pick();
    res.moved.forEach(x => { x.g.time = m2t(t2m(x.g.time) + d); });
    if (!res.moved.length) return false;
  });
  if (!ok) return;
  closeSheet();
  toast(t('delay.done', { n: res.moved.length, d }) + (res.skipped ? ' · ' + t('delay.skipped', { n: res.skipped }) : ''));
  rerender();
}

function editPairFromSheet(k) {
  const r = sheetRef, g = r && gameRef(r), cs = r && state[r.cid];
  if (!g) return;
  const gi = cs.groups.findIndex(grp => grp.teams.some(n => normName(n) === normName(g[k])));
  if (gi < 0) return;
  closeSheet();
  openEditTeam(r.cid, gi, cs.groups[gi].teams.findIndex(n => normName(n) === normName(g[k])));
}

function renderCourtFilter() {
  const el = document.getElementById('court-filter');
  if (!el) return;
  const cats = activeCat ? categories.filter(c=>c.id===activeCat) : categories;
  const courts = new Set();
  cats.forEach(cat => {
    const cs = state[cat.id];
    if (cs) {
      (cs.sched||[]).forEach(g => { if(g.court) courts.add(g.court); });
      (cs.ko||[]).flat().forEach(g => { if(g.court) courts.add(g.court); });
    }
    // Fallback when schedule not yet built
    if (!courts.size) {
      for (let i=1; i<=(cat.cfg?.courts||2); i++) courts.add(i);
    }
  });
  el.innerHTML = `<button class="cf-btn ${activeCourt==='all'?'on':''}" aria-pressed="${activeCourt==='all'}" onclick="setCourt('all')">${t('common.all')}</button>`
    + [...courts].sort((a,b)=>a-b).map(c =>
        `<button class="cf-btn ${activeCourt===c?'on':''}" aria-pressed="${activeCourt===c}" onclick="setCourt(${c})">${t('sched.court', { n: c })}</button>`).join('');
}

function setCourt(c) { activeCourt=c; renderCourtFilter(); renderScheduleContent(); }

// ============ BRACKET ============
const bmWhen = g => g.time && g.court ? `<div class="bm-when">${t('bracket.when', { time: g.time, n: g.court })}</div>` : '';
function renderBracketForCat(catId, container) {
  const cs  = state[catId];
  const cat = categories.find(c=>c.id===catId);
  if (!cs||!cat) return;
  const cfg = cat.cfg||DEF_CAT_CFG;
  const adv = cfg.advPerGroup||0;
  const ng  = cs.groups.length;

  updateKOForCat(catId);

  const poolGames = cs.sched.filter(g=>g.gi>=0);   // exclude the 3rd-place game (gi=-1)
  const done  = poolGames.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false),g)).length;
  const total = poolGames.length;
  const info  = document.createElement('div');
  info.className='binfo';
  info.innerHTML = !total ? t('bracket.noPool')
    : t('bracket.poolInfo', { progress: t('bracket.poolPlayed', { done, total }) });
  container.appendChild(info);
  if (!cs.ko.length) return;

  const koSeeds=[];
  for (let rank=1; rank<=adv; rank++)
    for (let g=0; g<ng; g++)
      koSeeds.push(`${String.fromCharCode(65+g)}${rank}`);
  const nKO=koSeeds.length;
  const seedPairs=[];
  for (let i=0; i<Math.floor(nKO/2); i++) seedPairs.push([koSeeds[i],koSeeds[nKO-1-i]]);

  const scroll=document.createElement('div'); scroll.className='bscroll'; scroll.dataset.cat=catId;
  const tree=document.createElement('div'); tree.className='btree';
  scroll.appendChild(tree);
  const HG=90, GAP=12;

  // Helper: build a single match box element
  const mkBox = (g, gi, ri) => {
    if (g.isBye) {
      const seed=g.seedA||g.a||'TBD';
      const res=resolvePoolSeed(catId,seed);
      const label=dnH(tSlot(res.known?res.label:seed));
      const box=document.createElement('div'); box.className='bmatch-box bmatch-box--bye';
      box.innerHTML=`<div class="bmatch bmatch-bye">
        <div class="bteam ${res.known?'win':'tbd'}">
          <span class="bname">${label}</span><span class="bye-badge">${t('bracket.direct')} <span class="flip-rtl">↗</span></span>
        </div>
      </div>`;
      return box;
    }
    const sa=parseInt(g.sa), sb=parseInt(g.sb);
    const hs=isValidScore(sa,sb,catId,getRuleForGame(catId,g,true),g);
    const wa=hs&&sa>sb, wb=hs&&sb>sa;
    let labelA=g.a||'TBD', labelB=g.b||'TBD', codeA='', codeB='', knownA=false, knownB=false, nameA='', nameB='';
    if (ri===0) {
      const sAk=g.seedA||seedPairs[gi]?.[0]||'TBD', sBk=g.seedB||seedPairs[gi]?.[1]||'TBD';
      const sA=resolvePoolSeed(catId,sAk), sB=resolvePoolSeed(catId,sBk);
      labelA=dnH(tSlot(sA.known?sA.label:sAk)); labelB=dnH(tSlot(sB.known?sB.label:sBk));
      codeA=sA.known?sAk:''; codeB=sB.known?sBk:'';
      knownA=sA.known; knownB=sB.known;
      nameA=sA.known?sA.label:''; nameB=sB.known?sB.label:'';
    } else {
      const isSeed = s => !s || s.startsWith('Winner') || /^[A-Z]\d+(\/[A-Z]\d+)?$/.test(s);
      knownA=!isSeed(g.a);
      knownB=!isSeed(g.b);
      nameA=knownA?g.a:''; nameB=knownB?g.b:'';
      if (g.directSeedA&&knownA) codeA=g.directSeedA;
      if (g.directSeedB&&knownB) codeB=g.directSeedB;
      labelA=dnH(tSlot(labelA)); labelB=dnH(tSlot(labelB));
    }
    const box=document.createElement('div'); box.className='bmatch-box';
    const glbl=tGameLbl(koGameLabel(catId,ri,gi));
    box.innerHTML=(glbl?`<div class="bm-label">${glbl}</div>`:'')+bmWhen(g)+`<div class="bmatch">
      <div class="bteam ${wa?'win':''} ${knownA?'':'tbd'}${g.directSeedA?' bdirect':''}${isMine(nameA)?' is-mine':''}">
        <span class="bname">${labelA}</span>${codeA?`<span class="bsc seed-tag" title="${escH(tSlot(codeA))}">${codeA}</span>`:''}${hs?`<span class="bsc num">${g.sa}</span>`:''}
      </div>
      <div class="bteam ${wb?'win':''} ${knownB?'':'tbd'}${g.directSeedB?' bdirect':''}${isMine(nameB)?' is-mine':''}">
        <span class="bname">${labelB}</span>${codeB?`<span class="bsc seed-tag" title="${escH(tSlot(codeB))}">${codeB}</span>`:''}${hs?`<span class="bsc num">${g.sb}</span>`:''}
      </div>
    </div>`;
    return box;
  };

  // Detect hybrid bracket: r0 and r1 same count, r1 has direct seeds
  const isHybrid = cs.ko.length >= 2 &&
    cs.ko[0].length === cs.ko[1]?.length &&
    cs.ko[1]?.some(g => g.directSeedA || g.directSeedB);

  const startRi = isHybrid ? 2 : 0;

  if (isHybrid) {
    // Render r0+r1 as paired horizontal lanes in one column
    const col=document.createElement('div'); col.className='bround'; col.dataset.ri=1;
    col.innerHTML=`<div class="brnd-title">${tRound(cs.ko.length-1)}<span class="brnd-arrow">→</span> ${tRound(cs.ko.length-2)}</div>`;
    const lanesEl=document.createElement('div'); lanesEl.className='brnd-matches hybrid-lanes';
    cs.ko[0].forEach((g0,gi) => {
      const g1 = cs.ko[1][gi];
      const lane = document.createElement('div');
      lane.className = 'hlane';
      if (gi>0) lane.style.marginTop='10px';
      // R16 box (smaller)
      const b0=mkBox(g0,gi,0); b0.classList.add('bmatch-box--sm'); lane.appendChild(b0);
      // Arrow
      const arr=document.createElement('div'); arr.className='hlane-arrow'; arr.textContent='→'; lane.appendChild(arr);
      // QF box
      lane.appendChild(mkBox(g1,gi,1));
      lanesEl.appendChild(lane);
    });
    col.appendChild(lanesEl); tree.appendChild(col);
  }

  // Standard columns (all rounds if not hybrid; r2+ if hybrid)
  cs.ko.forEach((round, ri) => {
    if (ri < startRi) return;
    const col=document.createElement('div'); col.className='bround'; col.dataset.ri=ri;
    col.innerHTML=`<div class="brnd-title">${tRound(cs.ko.length-1-ri)}</div>`;
    const matchesEl=document.createElement('div'); matchesEl.className='brnd-matches';
    let halvings=0;
    for (let k=startRi+1;k<=ri;k++) { if(cs.ko[k].length<cs.ko[k-1].length) halvings++; }
    // R16 with BYEs: show only 4 actual games with QF-matching spacing (halvings=1)
    // so connector lines to QF are perfectly horizontal
    const hasByePairs = ri===startRi && round.some(g=>g.isBye) && round[0]?.isBye;
    const effHalvings = hasByePairs ? 1 : halvings;
    matchesEl.style.paddingTop=((Math.pow(2,effHalvings)-1)*HG/2)+'px';
    const matchGap=(Math.pow(2,effHalvings)-1)*HG+GAP;
    // Cross display order for rounds feeding cross-SF
    const nextNonThird = cs.ko[ri+1]?.filter(g=>!g.isThirdPlace);
    const isCrossRound = round.length === 4 && nextNonThird?.length === 2;
    let displayOrder;
    if (hasByePairs) {
      // Show only non-BYE games in cross-aligned order [0,3,1,2]
      const nonBye = round.map((_,i)=>i).filter(i=>!round[i].isBye);
      displayOrder = [0,3,1,2].map(j=>nonBye[j]).filter(i=>i!=null);
    } else if (isCrossRound) {
      displayOrder = [0,3,1,2];
    } else {
      displayOrder = round.map((_,i)=>i);
    }
    displayOrder.forEach((gi, pos) => {
      const g = round[gi];
      const wrap=document.createElement('div'); wrap.className='bmatch-wrap';
      if (pos>0) wrap.style.marginTop=matchGap+'px';
      wrap.appendChild(mkBox(g,gi,ri));
      matchesEl.appendChild(wrap);
    });
    col.appendChild(matchesEl); tree.appendChild(col);
  });

  // 3rd place box — appended to Final column
  const thirdGame = cs.sched.find(g => g.isThirdPlace);
  if (thirdGame) {
    const lastCol = tree.querySelector('.bround:last-child');
    if (lastCol) {
      const sa3=parseInt(thirdGame.sa), sb3=parseInt(thirdGame.sb);
      const hs3=isValidScore(sa3,sb3,catId,getRuleForGame(catId,thirdGame,false),thirdGame);
      const wa3=hs3&&sa3>sb3, wb3=hs3&&sb3>sa3;
      const isSeed3=s=>!s||s.startsWith('Loser')||/^[A-Z]\d+(\/[A-Z]\d+)?$/.test(s);
      const lA3=dnH(tSlot(thirdGame.a)), lB3=dnH(tSlot(thirdGame.b));
      const knownA3=!isSeed3(thirdGame.a), knownB3=!isSeed3(thirdGame.b);
      const div3=document.createElement('div');
      div3.style.cssText='border-top:1px solid var(--border2);margin-top:16px;padding-top:10px;';
      const box3=document.createElement('div'); box3.className='bmatch-box';
      box3.innerHTML=`<div class="bm-label">${t('bracket.third')}</div>${bmWhen(thirdGame)}<div class="bmatch">
        <div class="bteam ${wa3?'win':''} ${knownA3?'':'tbd'}"><span class="bname">${lA3}</span>${hs3?`<span class="bsc num">${thirdGame.sa}</span>`:''}</div>
        <div class="bteam ${wb3?'win':''} ${knownB3?'':'tbd'}"><span class="bname">${lB3}</span>${hs3?`<span class="bsc num">${thirdGame.sb}</span>`:''}</div>
      </div>`;
      div3.appendChild(box3);
      lastCol.appendChild(div3);
    }
  }

  container.appendChild(scroll);
  drawBracketLines(scroll, catId);

  const fin=cs.ko[cs.ko.length-1][0];
  if (fin) {
    const fsa=parseInt(fin.sa),fsb=parseInt(fin.sb);
    if (isValidScore(fsa,fsb,catId,getRuleForGame(catId,fin,true),fin)) {
      const w=fsa>fsb?fin.a:fin.b;
      const champEl=document.createElement('div');
      champEl.innerHTML=`<div class="champ-wrap"><div class="ci">${t('bracket.champion')}</div><div class="champ-name">${dnH(w)}</div></div>`;
      container.appendChild(champEl);
    }
  }
}

function drawBracketLines(scroll, catId) {
  const cs = state[catId];
  if (!cs?.ko?.length) return;

  const doDraw = () => {
    scroll.querySelector('.bsvg')?.remove();
    const sR = scroll.getBoundingClientRect();
    if (!sR.width) return false;
    const SL = scroll.scrollLeft, ST = scroll.scrollTop;
    // RTL: round 0 sits on the right, and the content starts X0 px left of the scroller's edge.
    const rtl = getComputedStyle(scroll).direction === 'rtl';
    const X0 = rtl ? Math.min(0, scroll.clientWidth - scroll.scrollWidth) : 0;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class', 'bsvg');  // SVG className is read-only (SVGAnimatedString)
    Object.assign(svg.style, {
      position:'absolute', top:'0', left: X0+'px', pointerEvents:'none',
      width: scroll.scrollWidth+'px', height: scroll.scrollHeight+'px',
      overflow:'visible', zIndex:'0'
    });
    scroll.style.position = 'relative';

    const rounds = [...scroll.querySelectorAll('.bround')];
    // Theme token (set by applyTheme) — white lines were invisible on the light theme.
    const C = 'var(--border2)';

    const mk = (x1,y1,x2,y2) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg','line');
      el.setAttribute('x1',Math.round(x1)); el.setAttribute('y1',Math.round(y1));
      el.setAttribute('x2',Math.round(x2)); el.setAttribute('y2',Math.round(y2));
      el.style.stroke = C; el.setAttribute('stroke-width','2');
      el.setAttribute('stroke-linecap','round');
      svg.appendChild(el);
    };

    const getPos = wrap => {
      const b = wrap.querySelector('.bmatch-box');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const left = r.left - sR.left + SL - X0, right = left + r.width;
      // rx = edge facing the next round, lx = edge facing the previous one
      return {
        rx: rtl ? left : right,
        lx: rtl ? right : left,
        my: r.top  - sR.top  + ST + r.height / 2
      };
    };

    for (let ci = 0; ci < rounds.length - 1; ci++) {
      const srcWraps = [...rounds[ci].querySelectorAll('.bmatch-wrap')];
      const dstWraps = [...rounds[ci+1].querySelectorAll('.bmatch-wrap')];
      if (!srcWraps.length || !dstWraps.length) continue;
      const srcPos = srcWraps.map(getPos).filter(Boolean);
      const dstPos = dstWraps.map(getPos).filter(Boolean);

      if (srcPos.length === dstPos.length) {
        // 1:1 — R16 actual games → QF (horizontal lines)
        dstPos.forEach((dst, di) => {
          const s = srcPos[di];
          if (!s) return;
          const vx = (s.rx + dst.lx) / 2;
          mk(s.rx, s.my, vx, s.my);
          mk(vx, s.my, dst.lx, dst.my);
        });
      } else {
        // 2:1 — standard bracket connector (QF→SF, SF→Final)
        dstPos.forEach((dst, di) => {
          const s0 = srcPos[di*2], s1 = srcPos[di*2+1];
          if (!s0) return;
          const vx = ((rtl ? Math.min : Math.max)(s0.rx, s1?.rx ?? s0.rx) + dst.lx) / 2;
          mk(s0.rx, s0.my, vx, s0.my);
          if (s1) { mk(s1.rx, s1.my, vx, s1.my); mk(vx, s0.my, vx, s1.my); }
          mk(vx, dst.my, dst.lx, dst.my);
        });
      }
    }
    scroll.prepend(svg);
    return true;
  };

  // Double RAF to ensure layout is complete; retry after 150ms if tab was hidden
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!doDraw()) setTimeout(() => requestAnimationFrame(doDraw), 150);
    });
  });
}

// Connector lines are absolutely positioned from measured boxes, so they go
// stale when the viewport changes. Redraw (debounced) on resize / rotation.
let _bracketResizeT = null;
function redrawBracketLinesSoon() {
  clearTimeout(_bracketResizeT);
  _bracketResizeT = setTimeout(() => {
    if (!document.getElementById('page-bracket')?.classList.contains('on')) return;
    document.querySelectorAll('#bracket-container .bscroll[data-cat]').forEach(sc => drawBracketLines(sc, sc.dataset.cat));
  }, 200);
}
window.addEventListener('resize', redrawBracketLinesSoon);
window.addEventListener('orientationchange', redrawBracketLinesSoon);

function renderBracket() {
  const container=document.getElementById('bracket-container');
  if (!container) return;
  // Live updates keep each bracket's horizontal scroll; a fresh view opens on the current round.
  const prev = {};
  if (document.getElementById('page-bracket')?.classList.contains('on'))
    container.querySelectorAll('.bscroll[data-cat]').forEach(sc => { prev[sc.dataset.cat] = sc.scrollLeft; });
  container.innerHTML='';
  const cats=activeCat?categories.filter(c=>c.id===activeCat):categories;
  cats.forEach(cat => {
    if (cats.length>1) {
      const hdr=document.createElement('div');
      hdr.className='cat-section-header'; hdr.textContent=cat.name;
      container.appendChild(hdr);
    }
    renderBracketForCat(cat.id, container);
    const sc = [...container.querySelectorAll('.bscroll[data-cat]')].find(x => x.dataset.cat === cat.id);
    if (!sc) return;
    if (cat.id in prev) { sc.scrollLeft = prev[cat.id]; return; }
    const ri = state[cat.id].ko.findIndex(r => r.some(g => !g.isBye && !isValidScore(parseInt(g.sa), parseInt(g.sb), cat.id, getRuleForGame(cat.id, g, true), g)));
    const col = [...sc.querySelectorAll('.bround[data-ri]')].find(c => +c.dataset.ri >= ri);
    if (ri <= 0 || !col) return;
    const c = col.getBoundingClientRect(), r = sc.getBoundingClientRect();
    sc.scrollLeft += getComputedStyle(sc).direction === 'rtl' ? c.right - r.right : c.left - r.left;
  });
}

// ============ CATEGORY FILTER ============
function setCat(id) {
  activeCat=id; activeCourt='all';
  renderCatFilters();
  rerender();
}

function renderCatFilters() {
  const el = document.getElementById('sticky-cat');
  if (!el) return;
  const onTournamentPage = ['standings','schedule','bracket'].some(p =>
    document.getElementById('page-'+p)?.classList.contains('on'));
  if (categories.length <= 1 || !onTournamentPage) {
    el.innerHTML = '';
    el.classList.add('h');
    return;
  }
  el.classList.remove('h');
  el.innerHTML = `<div class="cat-filter">
    <button class="cat-btn ${!activeCat?'on':''}" aria-pressed="${!activeCat}" onclick="setCat(null)">${t('common.all')}</button>
    ${categories.map(c=>`<button class="cat-btn ${activeCat===c.id?'on':''}" aria-pressed="${activeCat===c.id}" onclick="setCat('${escH(c.id)}')">${escH(c.name)}</button>`).join('')}
  </div>`;
}

// ============ SETTINGS ============
function renderSettings() {
  const container = document.getElementById('settings-container');
  if (!container || !superAdmin) return;
  // Rebuilding empties the page for a moment — keep the scroll position (e.g. on "add category").
  const keepY = window.scrollY;
  container.innerHTML = '';

  // Tournament phase: only what is safe to change while games run.
  if (meta.phase === 'tournament') {
    const live = document.createElement('div');
    live.className = 'sett-section';
    live.innerHTML = `<div class="sett-section-title">${t('settings.title')}</div>
      <p class="sett-desc">${t('settings.liveNote')}</p>
      <div class="sett-row">
        <div class="sett-label"><span class="sett-name">${t('settings.name')}</span></div>
        <div class="sett-ctrl">
          <input class="text-inp" style="width:220px" dir="auto" value="${escH(meta.name)}" onchange="updateMeta('name',this.value)"/>
        </div>
      </div>
      ${coordBuild() && categories.length ? `<div class="sett-row" style="flex-wrap:wrap">
        <div class="sett-label"><span class="sett-name">${t('settings.wholeTournament')}</span></div>
        <div class="cat-settings-grid">${catNumField(t('settings.gameDur'), -1, 'gameDur', (categories[0].cfg || DEF_CAT_CFG).gameDur, 5, 120)}</div>
      </div>` : ''}
      ${categories.map((cat, ci) => renderCatItem(cat, ci, true)).join('')}`;
    container.appendChild(live);
    window.scrollTo(0, keepY);
    return;
  }

  // ── DESIGN ──────────────────────────────────────────────────────
  const pc = meta.primaryColor   || DEF_PRIMARY;
  const sc = meta.secondaryColor || pc;
  const dsec = document.createElement('div');
  dsec.className = 'sett-section';
  dsec.innerHTML = `
    <div class="sett-section-title">${t('settings.design')}</div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">${t('settings.name')}</span></div>
      <div class="sett-ctrl">
        <input class="text-inp" style="width:220px" dir="auto" value="${escH(meta.name)}"
          onchange="updateMeta('name',this.value)" placeholder="${t('settings.namePh')}"/>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label">
        <span class="sett-name">${t('settings.lang')}</span>
        <span class="sett-desc">${t('settings.langDesc')}</span>
      </div>
      <div class="sett-ctrl">
        <select class="text-inp" aria-label="${t('lang.aria')}" onchange="updateMeta('lang',this.value)">
          <option value="he" ${meta.lang!=='en'?'selected':''}>עברית</option>
          <option value="en" ${meta.lang==='en'?'selected':''}>English</option>
        </select>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label">
        <span class="sett-name">${t('settings.primary')}</span>
        <span class="sett-desc">${t('settings.primaryDesc')}</span>
      </div>
      <div class="sett-ctrl color-pick-row">
        <input type="color" class="color-inp" id="cp-primary" value="${pc}"
          oninput="document.getElementById('ct-primary').value=this.value;updateMeta('primaryColor',this.value)"/>
        <input class="text-inp text-mono" id="ct-primary" style="width:100px" value="${pc}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('cp-primary').value=this.value;updateMeta('primaryColor',this.value)}"/>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label">
        <span class="sett-name">${t('settings.secondary')}</span>
        <span class="sett-desc">${t('settings.secondaryDesc')}</span>
      </div>
      <div class="sett-ctrl color-pick-row">
        <input type="color" class="color-inp" id="cp-secondary" value="${sc}"
          oninput="document.getElementById('ct-secondary').value=this.value;updateMeta('secondaryColor',this.value)"/>
        <input class="text-inp text-mono" id="ct-secondary" style="width:100px" value="${sc}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('cp-secondary').value=this.value;updateMeta('secondaryColor',this.value)}"/>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">${t('settings.preview')}</span></div>
      <div class="theme-preview" style="background:linear-gradient(135deg,${pc},${sc})">
        <span style="color:${onColor(pc)};font-family:inherit;font-weight:700;font-size:14px;letter-spacing:1px">Aa</span>
      </div>
    </div>
    <div class="sett-row" style="border-bottom:none;padding-bottom:0">
      <div class="sett-label">
        <span class="sett-name">${t('settings.bg')}</span>
        <span class="sett-desc">${t('settings.bgDesc')}</span>
      </div>
      <div class="sett-ctrl color-pick-row">
        <input type="color" class="color-inp" id="cp-bg" value="${meta.bgColor||'#ffffff'}"
          oninput="document.getElementById('ct-bg').value=this.value;updateBgColor(this.value)"/>
        <input class="text-inp text-mono" id="ct-bg" style="width:100px" value="${meta.bgColor||'#ffffff'}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('cp-bg').value=this.value;updateBgColor(this.value)}"/>
        <button class="add-cat-btn" onclick="updateBgColor('')">${t('common.reset')}</button>
      </div>
    </div>`;
  container.appendChild(dsec);

  // ── LOGO ────────────────────────────────────────────────────────
  const lsec = document.createElement('div');
  lsec.className = 'sett-section';
  lsec.innerHTML = `
    <div class="sett-section-title">${t('settings.logo')}</div>
    <div class="sett-row" style="border-bottom:none">
      <div class="sett-label">
        <span class="sett-name">${t('settings.logo')}</span>
        <span class="sett-desc">${t('settings.logoUploadDesc')}</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:10px">
        <div class="d-drop" id="logo-drop" aria-label="${t('settings.logoDropAria')}">
          ${meta.logoUrl
            ? `<img src="${escH(meta.logoUrl)}" class="logo-prev-img" alt="${t('settings.logoCurrent')}" onerror="this.style.display='none'"/>`
            : `<span class="d-drop-hint">${t('settings.logoDropHint')}</span>`}
        </div>
        <div id="logo-drop-err" class="d-drop-err" role="alert" style="display:none"></div>
        ${meta.logoUrl ? `<button type="button" class="add-cat-btn" onclick="removeLogo()">${t('settings.removeLogo')}</button>` : ''}
        <input class="text-inp" type="url" dir="ltr" style="width:260px" value="${isDataUrl(meta.logoUrl) ? '' : escH(meta.logoUrl)}"
          onchange="updateMeta('logoUrl',this.value.trim());renderSettings()"
          placeholder="${isDataUrl(meta.logoUrl) ? t('settings.uploadedPh') : 'https://…'}" aria-label="${t('settings.logoUrl')}"/>
      </div>
    </div>`;
  container.appendChild(lsec);
  attachDropZone(lsec.querySelector('#logo-drop'), (url, err) => {
    if (url && !metaFits({ logoUrl: url })) { url = null; err = t('errors.metaFull'); }
    const errEl = document.getElementById('logo-drop-err');
    if (errEl) { errEl.textContent = err || ''; errEl.style.display = err ? '' : 'none'; }
    if (url) { updateMeta('logoUrl', url); renderSettings(); }
  }, { maxBytes: 60000 });

  // ── GROUP COLORS ─────────────────────────────────────────────────
  const grpNames = ['A','B','C','D'];
  const grpCur = grpColors();
  const gcsec = document.createElement('div');
  gcsec.className = 'sett-section';
  gcsec.innerHTML = `<div class="sett-section-title">${t('settings.groupColors')}</div>` +
    grpNames.map((n,i) => {
      const cur = grpCur[i];
      return `<div class="sett-row${i===grpNames.length-1?' last-row':''}">
        <div class="sett-label"><span class="sett-name">${t('stand.group', { name: n })}</span></div>
        <div class="sett-ctrl color-pick-row">
          <input type="color" class="color-inp" id="gcp-${i}" value="${cur}"
            oninput="document.getElementById('gct-${i}').value=this.value;updateGroupColor(${i},this.value)"/>
          <input class="text-inp text-mono" id="gct-${i}" style="width:100px" value="${cur}"
            onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('gcp-${i}').value=this.value;updateGroupColor(${i},this.value)}"/>
          <button class="add-cat-btn"
            onclick="updateGroupColor(${i},'');renderSettings()">${t('common.reset')}</button>
        </div>
      </div>`;
    }).join('');
  container.appendChild(gcsec);

  // ── SPONSORS ────────────────────────────────────────────────────
  const ssec = document.createElement('div');
  ssec.className = 'sett-section';
  const logos = Array.isArray(meta.sponsorLogos) ? meta.sponsorLogos : [];
  ssec.innerHTML = `
    <div class="sett-section-title">${t('settings.sponsors')}</div>
    <div id="sponsor-edit-list">${logos.length
      ? logos.map((l,i) => `
        <div class="sprow">
          <div class="sp-thumb">${l.url
            ? `<img src="${escH(l.url)}" alt="" onerror="this.style.display='none'" style="max-width:52px;max-height:32px;object-fit:contain"/>`
            : `<span style="color:var(--text3);font-size:20px;line-height:1">+</span>`}</div>
          <input class="text-inp" type="url" dir="ltr" style="flex:1;min-width:0" value="${isDataUrl(l.url) ? '' : escH(l.url)}"
            placeholder="${isDataUrl(l.url) ? t('settings.uploadedPh') : t('settings.sponsorUrlPh')}" onchange="updateSponsorLogo(${i},'url',this.value.trim())"/>
          <button type="button" class="add-cat-btn" style="flex-shrink:0" onclick="uploadSponsorLogo(${i})">${t('settings.upload')}</button>
          <input class="text-inp" dir="auto" style="width:100px;flex-shrink:0" value="${escH(l.alt)}"
            placeholder="${t('settings.sponsorNamePh')}" onchange="updateSponsorLogo(${i},'alt',this.value)"/>
          <button class="team-del" onclick="removeSponsorLogo(${i})" title="${t('common.remove')}" aria-label="${t('common.remove')}">✕</button>
        </div>`).join('')
      : `<p class="sett-empty-note">${t('settings.noSponsors')}</p>`}
    </div>
    <div id="sponsor-upload-err" class="d-drop-err" role="alert" style="display:none"></div>
    <div class="sett-add-row">
      <button class="add-cat-btn" onclick="addSponsorLogo()">${t('settings.addSponsor')}</button>
    </div>`;
  container.appendChild(ssec);

  // ── PLAYERS DATABASE ────────────────────────────────────────────
  if (secure) renderSecurePwSection(container); else renderPlayerDBSection(container);

  // ── GROUPS ──────────────────────────────────────────────────────
  const groupHasCats = categories.some(cat => state[cat.id]?.groups?.length);
  if (groupHasCats) {
    const gsec = document.createElement('div');
    gsec.className = 'sett-section';
    const gHtml = categories.map((cat, ci) => {
      const cs = state[cat.id];
      if (!cs || !cs.groups.length) return '';
      return `<div class="grp-cat-block">
        <div class="grp-cat-name">${escH(cat.name)}</div>
        ${cs.groups.map((grp, gi) => `
          <div class="grp-row">
            <div class="grp-row-head">
              <span class="sett-desc" style="flex-shrink:0">${t('settings.groupLabel')}</span>
              <input class="text-inp" dir="auto" style="width:54px;font-weight:700;text-align:center"
                value="${escH(grp.name)}" onchange="renameGroup('${cat.id}',${gi},this.value)"/>
              <span class="sett-desc" style="margin-inline-start:4px">${t('settings.teamsCount', { n: grp.teams.length })}</span>
            </div>
            <div class="grp-teams-list">
              ${grp.teams.map((team, ti) => `
                <div class="grp-team-item">
                  <span class="grp-team-name">${dnH(team)}</span>
                  ${cs.groups.length > 1 ? `<select class="move-sel"
                    onchange="moveTeam('${cat.id}',${gi},${ti},parseInt(this.value));this.selectedIndex=0">
                    <option value="" disabled selected>${t('settings.moveTo')}</option>
                    ${cs.groups.map((tg,gj) => gj===gi ? '' : `<option value="${gj}">${t('settings.moveToGroup', { name: escH(tg.name) })}</option>`).join('')}
                  </select>` : ''}
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>`;
    }).join('');
    gsec.innerHTML = `<div class="sett-section-title">${t('settings.groups')}</div>${gHtml}`;
    container.appendChild(gsec);
  }

  // ── SPORT ───────────────────────────────────────────────────────
  const sportSection = document.createElement('div');
  sportSection.className = 'sett-section';
  sportSection.innerHTML = `<div class="sett-section-title">${t('settings.sport')}</div>
    <div class="sett-row" style="border-bottom:none;align-items:flex-start">
      <div class="sett-label"><span class="sett-name">${t('settings.sport')}</span>
        <span class="sett-desc">${t('settings.sportDesc')}</span></div>
      <div class="sett-ctrl">
        <select class="text-inp" onchange="updateMeta('sport',this.value)">
          <option value="footvolley" ${meta.sport!=='volleyball'?'selected':''}>${t('settings.sportFootvolley')}</option>
          <option value="volleyball" ${meta.sport==='volleyball'?'selected':''}>${t('settings.sportVolleyball')}</option>
        </select>
      </div>
    </div>`;
  container.appendChild(sportSection);

  // ── REGISTRATION ────────────────────────────────────────────────
  const regSection = document.createElement('div');
  regSection.className = 'sett-section';
  regSection.innerHTML = `<div class="sett-section-title">${t('settings.registration')}</div>
    <div class="toggle-row">
      <span class="toggle-label">${t('settings.regOpen')}</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.regOpen?'checked':''} onchange="updateMeta('regOpen',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row" style="border-bottom:none">
      <span class="toggle-label">${t('settings.showList')}</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.showRegistered?'checked':''} onchange="updateMeta('showRegistered',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="sett-row" style="flex-direction:column;align-items:stretch;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">${t('settings.regNote')}</span>
        <span class="sett-desc">${t('settings.regNoteDesc')} ${t('settings.regNoteHelp')}</span>
      </div>
      <textarea class="text-inp reg-note-editor" dir="auto" aria-label="${t('settings.regNote')}"
        oninput="previewRegNote(this)" onchange="updateMeta('regNote',this.value)"
        placeholder="${t('settings.regNotePh')}">${escH(meta.regNote)}</textarea>
      <div class="reg-note md reg-note-preview"></div>
    </div>
    <div class="sett-row" style="align-items:flex-start;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">${t('settings.info')}</span>
        <span class="sett-desc">${t('settings.infoDesc')}</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:8px">
        <input class="text-inp" type="date" style="width:190px" value="${escH(meta.eventDate)}" aria-label="${t('settings.eventDate')}"
          onchange="updateMeta('eventDate',this.value)"/>
        <input class="text-inp" dir="auto" style="width:240px" value="${escH(meta.venue)}" placeholder="${t('settings.venuePh')}" aria-label="${t('settings.venue')}"
          onchange="updateMeta('venue',this.value.trim())"/>
        <input class="text-inp" dir="auto" style="width:240px" value="${escH(meta.price)}" placeholder="${t('settings.pricePh')}" aria-label="${t('settings.price')}"
          onchange="updateMeta('price',this.value.trim())"/>
      </div>
    </div>
    <div class="sett-row" style="align-items:flex-start;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">${t('settings.payLinks')}</span>
        <span class="sett-desc">${t('settings.payLinksDesc')}</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:8px">
        <div style="display:flex;gap:6px;align-items:center">
          <input class="text-inp" dir="auto" value="${escH(meta.paymentLinkLabel)}" style="width:160px" placeholder="${t('settings.labelPh')}"
            onchange="updateMeta('paymentLinkLabel',this.value)"/>
          <input class="text-inp" type="url" dir="ltr" value="${escH(meta.paymentLink)}" style="width:190px" placeholder="https://…"
            onchange="this.value=payUrl(this.value);updateMeta('paymentLink',this.value)"/>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="text-inp" dir="auto" value="${escH(meta.paymentLink2Label)}" style="width:160px" placeholder="${t('settings.labelPh')}"
            onchange="updateMeta('paymentLink2Label',this.value)"/>
          <input class="text-inp" type="url" dir="ltr" value="${escH(meta.paymentLink2)}" style="width:190px" placeholder="${t('settings.urlOptionalPh')}"
            onchange="this.value=payUrl(this.value);updateMeta('paymentLink2',this.value)"/>
        </div>
      </div>
    </div>`;
  container.appendChild(regSection);
  previewRegNote(regSection.querySelector('.reg-note-editor'));

  // ── CATEGORIES ──────────────────────────────────────────────────
  // One shared grid: courts / minutes / break / start apply to the whole tournament.
  const c0 = categories[0]?.cfg || DEF_CAT_CFG;
  const coordHtml = coordBuild() && categories.length ? `<div class="sett-row" style="flex-wrap:wrap">
      <div class="sett-label"><span class="sett-name">${t('settings.wholeTournament')}</span></div>
      <div class="cat-settings-grid">
        ${catNumField(t('settings.courts'), -1, 'courts', coordCfg().COURTS, 1, 8)}
        ${catNumField(t('settings.gameDur'), -1, 'gameDur', c0.gameDur, 5, 120)}
        ${catNumField(t('settings.breakDur'), -1, 'breakDur', c0.breakDur, 0, 60)}
        <div class="cat-sett-field">
          <span class="cat-sett-label">${t('settings.startTime')}</span>
          <div class="cat-sett-ctrl">
            <input type="time" class="time-inp" value="${meta.startTime || c0.startTime || '08:00'}" onchange="updateCatCfg(-1,'startTime',this.value)"/>
          </div>
        </div>
      </div>
    </div>` : '';
  const toggles = categories.length >= 2 ? ['coordinated', 'parallelCategories', 'allPoolsBeforeKO'].map(k => `<div class="toggle-row">
      <div class="sett-label toggle-label">
        <span class="sett-name">${t('settings.' + k)}</span>
        <span class="sett-desc">${t('settings.' + k + 'Desc')} ${t('settings.nextBuild')}</span>
      </div>
      <label class="toggle-switch"><input type="checkbox" ${meta[k]?'checked':''} onchange="updateMeta('${k}',this.checked)"/><span class="toggle-slider"></span></label>
    </div>`).join('') : '';
  const catSection = document.createElement('div');
  catSection.className = 'sett-section';
  catSection.innerHTML = `<div class="sett-section-title">${t('settings.categories')}</div>${toggles}${coordHtml}
    <div id="cat-list">${categories.map((cat,ci)=>renderCatItem(cat,ci)).join('')}</div>
    <div class="sett-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:14px;border-bottom:none;padding-bottom:0">
      <div class="sett-label">
        <span class="sett-name">${t('settings.addCategory')}</span>
        <span class="sett-desc">${t('settings.addCategoryDesc')}</span>
      </div>
      <button class="add-cat-btn" onclick="addCategory()">${t('common.addPlus')}</button>
    </div>`;
  container.appendChild(catSection);

  // ── START TOURNAMENT ────────────────────────────────────────────
  const startSection = document.createElement('div');
  startSection.className = 'sett-section';
  startSection.style.textAlign = 'center';
  startSection.innerHTML = `
    <div class="sett-section-title">${t('settings.start')}</div>
    <p style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.55">${t('settings.startNote')}</p>
    <button class="gen-btn" onclick="openStartModal()" ${categories.length ? '' : 'disabled'}>${t('build.start')}</button>`;
  container.appendChild(startSection);
  window.scrollTo(0, keepY);
}

// ── Dynamic group color CSS ──────────────────────────────────────
// Empty group colour = the tournament's primary colour.
const grpColors = () => [0,1,2,3].map(i => (meta.groupColors||[])[i] || meta.primaryColor || DEF_PRIMARY);
function applyGroupColors() {
  const colors = grpColors();
  const style = document.getElementById('grp-color-style') || (() => {
    const s=document.createElement('style'); s.id='grp-color-style'; document.head.appendChild(s); return s;
  })();
  style.textContent = colors.map((c,i) => `.gi${i}{--gc:${c}}`).join('');
}

// ── Site colors ──────────────────────────────────────────────────
function updateBgColor(color) {
  meta.bgColor = color;
  document.body.style.backgroundColor = color;
  pushMeta('bgColor');
}
function updateGroupColor(gi, color) {
  // Ensure full 4-element array (avoids sparse array issues in Firestore)
  const cur = [0,1,2,3].map(i => (meta.groupColors||[])[i] || '');
  cur[gi] = color;
  meta.groupColors = cur;
  applyGroupColors();
  pushMeta('groupColors');
  renderStandings();
  renderBuildPage();
  renderScheduleContent();
}

// ── Category color ───────────────────────────────────────────────
function updateCatColor(ci, color) {
  if (!categories[ci]) return;
  categories[ci].color = color;
  pushCategories();
  renderStandings();
  renderBuildPage();
}

// ── Group management ─────────────────────────────────────────────
async function renameGroup(catId, gi, name) {
  if (!state[catId]?.groups[gi]) return;
  await commitState(catId, cs => {
    if (!cs.groups[gi]) return false;
    cs.groups[gi].name = name;
    cs.sched.forEach(g => { if (g.gi === gi) g.gn = name; });
  });
  renderStandings();
  renderScheduleContent();
}

async function moveTeam(catId, fromGi, teamIdx, toGi) {
  if (fromGi === toGi) return;
  const team = state[catId]?.groups[fromGi]?.teams[teamIdx];
  if (!team || !state[catId].groups[toGi]) return;
  const scored = cs => cs.sched.some(g => (g.gi === fromGi || g.gi === toGi) && hasScore(g));
  if (scored(state[catId])) { toast(t('move.scored')); renderSettings(); return; }
  await commitState(catId, cs => {
    const from = cs.groups[fromGi], to = cs.groups[toGi];
    const i = from?.teams.indexOf(team) ?? -1;
    if (i < 0 || !to || scored(cs)) return false;
    from.teams.splice(i, 1);
    cs.sched = cs.sched.filter(g => !(g.gi === fromGi && (g.a === team || g.b === team)));
    if (cs.sched.length) {
      const games = to.teams.map(b => ({ catId, gi: toGi, gn: to.name, a: team, b, sa: '', sb: '', court: '', time: '' }));
      cs.sched.push(...games);
      placeLateGames(catId, games);
    }
    to.teams.push(team);
  });
  renderStandings();
  renderSettings();
}

// ── Sponsor management ───────────────────────────────────────────
function updateSponsorLogo(i, key, val) {
  if (!Array.isArray(meta.sponsorLogos)) meta.sponsorLogos = [];
  if (!meta.sponsorLogos[i]) meta.sponsorLogos[i] = { url: '', alt: '' };
  meta.sponsorLogos[i][key] = val;
  renderSponsorBar();
  renderSettings();
  pushMeta('sponsorLogos');
}
const isDataUrl = u => /^data:image\//i.test(u || '');
// The tournament doc must stay well under Firestore's 1 MiB limit (images are data URLs).
const metaFits = patch => JSON.stringify({ ...meta, ...patch }).length <= 500000;
function removeLogo() {
  updateMeta('logoUrl', '');
  renderSettings();
}
async function uploadSponsorLogo(i) {
  const errEl = () => document.getElementById('sponsor-upload-err');
  try {
    const url = await pickImage({ maxPx: 512, maxBytes: 25000 });
    const logos = [...(meta.sponsorLogos || [])];
    logos[i] = { ...(logos[i] || { alt: '' }), url };
    if (!metaFits({ sponsorLogos: logos })) throw new Error(t('errors.metaFull'));
    const e = errEl(); if (e) e.style.display = 'none';
    updateSponsorLogo(i, 'url', url);
  } catch (e) {
    if (e && e.cancelled) return;
    const el = errEl();
    if (el) { el.textContent = (e && e.message) || t('errors.uploadFailed'); el.style.display = ''; }
  }
}
function removeSponsorLogo(i) {
  if (!Array.isArray(meta.sponsorLogos)) return;
  meta.sponsorLogos.splice(i, 1);
  renderSponsorBar();
  renderSettings();
  pushMeta('sponsorLogos');
}
function addSponsorLogo() {
  if (!Array.isArray(meta.sponsorLogos)) meta.sponsorLogos = [];
  meta.sponsorLogos.push({ url: '', alt: '' });
  renderSettings();
}

const KO_STAGES = ['pool', 'r16', 'qf', 'sf', 'third', 'final'];
const KO_LIM = { pts: [11, 30], change: [0, 15], dur: [5, 60], thirdPts: [11, 30] };
const KO_COL = { pts: 'settings.rules.pts', change: 'settings.rules.switch', dur: 'settings.rules.min', thirdPts: 'settings.rules.thirdPts' };
function renderCatItem(cat, ci, live) {
  const cfg=cat.cfg||DEF_CAT_CFG;
  const coord=coordBuild();
  const catColor = cat.color || meta.primaryColor || DEF_PRIMARY;
  return `<div class="cat-item">
    <div class="cat-item-head">
      <input class="text-inp" dir="auto" style="width:150px;font-weight:600" value="${escH(cat.name)}" onchange="updateCatName(${ci},this.value)"/>
      ${live ? '' : `<div class="color-pick-row" style="margin-inline-start:auto;margin-inline-end:8px">
        <input type="color" class="color-inp" id="ccp-${ci}" value="${catColor}"
          oninput="document.getElementById('cct-${ci}').value=this.value;updateCatColor(${ci},this.value)"/>
        <input class="text-inp text-mono" id="cct-${ci}" style="width:100px" value="${catColor}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('ccp-${ci}').value=this.value;updateCatColor(${ci},this.value)}"/>
      </div>
      <button class="team-del" onclick="deleteCategory(${ci})" title="${t('settings.deleteCategory')}" aria-label="${t('settings.deleteCategory')}">✕</button>`}
    </div>
    ${live ? (coord ? '' : `<div class="cat-settings-grid">${catNumField(t('settings.gameDur'), ci, 'gameDur', cfg.gameDur, 5, 120)}</div>`) : `<div class="cat-settings-grid">
      ${coord ? '' : catNumField(t('settings.courts'), ci, 'courts', cfg.courts, 1, 8)}
      ${catNumField(t('settings.numGroups'), ci, 'numGroups', cfg.numGroups, 2, 16)}
      ${catNumField(t('settings.advPerGroup'), ci, 'advPerGroup', cfg.advPerGroup, 1, 8)}
      ${(n => n > 1 ? `<span class="sett-desc" style="grid-column:1/-1">${t('settings.koHint', { n, round: tRound(Math.ceil(Math.log2(n)) - 1, 2 ** Math.ceil(Math.log2(n))) })}</span>` : '')((cfg.numGroups||0) * (cfg.advPerGroup||0))}
      ${coord ? '' : catNumField(t('settings.gameDur'), ci, 'gameDur', cfg.gameDur, 5, 120)}
      ${coord ? '' : catNumField(t('settings.breakDur'), ci, 'breakDur', cfg.breakDur, 0, 60)}
      <div class="cat-sett-field">
        <span class="cat-sett-label">${t('settings.sets')}</span>
        <div class="cat-sett-ctrl">
          <select class="form-input" style="width:80px" onchange="updateCatCfg(${ci},'sets',parseInt(this.value))">
            <option value="1" ${cfg.sets===1?'selected':''}>1</option>
            <option value="3" ${cfg.sets===3?'selected':''}>3</option>
          </select>
        </div>
      </div>
      ${cfg.sets===3?catNumField(t('settings.thirdSetPts'), ci, 'pointsThirdSet', cfg.pointsThirdSet||15, 11, 30):''}
      ${coord ? '' : `<div class="cat-sett-field">
        <span class="cat-sett-label">${t('settings.startTime')}</span>
        <div class="cat-sett-ctrl">
          <input type="time" class="time-inp" value="${cfg.startTime||'08:00'}" onchange="updateCatCfg(${ci},'startTime',this.value)"/>
        </div>
      </div>`}
    </div>`}
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <div class="cat-sett-label" style="margin-bottom:8px">${t('settings.scoringRules')}</div>
      <div class="srt-wrap"><table class="scoring-rules-tbl">
        <thead><tr><th>${t('settings.rules.stage')}</th><th>${t('settings.rules.pts')}</th><th>${t('settings.rules.switch')}</th>${coord ? '' : `<th>${t('settings.rules.min')}</th>`}<th>${t('settings.rules.sets')}</th><th>${t('settings.rules.thirdPts')}</th></tr></thead>
        <tbody>
          ${['all', ...KO_STAGES].map(key => {
            const label = t(key === 'all' ? 'settings.koSameAll' : 'settings.stage.' + key);
            const r = { ...DEF_KO_RULES[key === 'all' ? 'pool' : key], ...(cfg.koRules?.[key === 'all' ? 'pool' : key]||{}) };
            const inp = (f, v) => `<input class="text-inp" type="number" inputmode="numeric" style="width:64px" min="${KO_LIM[f][0]}" max="${KO_LIM[f][1]}"
              value="${v ?? ''}" aria-label="${label} · ${t(KO_COL[f])}" onchange="updateKORuleField(${ci},'${key}','${f}',this.value)"/>`;
            return `<tr>
              <td class="srt-label">${label}</td>
              <td>${inp('pts', r.pts||15)}</td>
              <td>${inp('change', r.change||'')}</td>
              ${coord ? '' : `<td>${inp('dur', r.dur||cfg.gameDur||15)}</td>`}
              <td><select class="form-input" style="width:64px" aria-label="${label} · ${t('settings.rules.sets')}" onchange="updateKORuleField(${ci},'${key}','sets',this.value)">
                <option value="1" ${r.sets===3?'':'selected'}>1</option>
                <option value="3" ${r.sets===3?'selected':''}>3</option>
              </select></td>
              <td>${r.sets===3 ? inp('thirdPts', r.thirdPts||15) : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
  </div>`;
}

function catNumField(label, ci, key, val, min, max) {
  return `<div class="cat-sett-field">
    <span class="cat-sett-label">${label}</span>
    <div class="cat-sett-ctrl">
      <button class="s-num-btn" onclick="adjCatCfg(${ci},'${key}',-1,${min},${max})">−</button>
      <span class="s-num-val">${val||0}</span>
      <button class="s-num-btn" onclick="adjCatCfg(${ci},'${key}',1,${min},${max})">+</button>
    </div>
  </div>`;
}

function updateMeta(key, val) {
  meta[key] = val;
  if (key==='primaryColor' || key==='secondaryColor') {
    applyTheme(meta.primaryColor, meta.secondaryColor);
    applyGroupColors();
  }
  if (key==='name') {
    document.getElementById('header-name').textContent=val;
    document.title=val||t('common.appName');
    const ll=document.getElementById('logo-letter');
    if (ll) ll.textContent=(val||'T')[0].toUpperCase();
  }
  if (key==='logoUrl') applyLogo(val);
  if (key==='phase') {
    document.body.classList.toggle('phase-registration', val==='registration');
    document.body.classList.toggle('phase-built',        val==='built');
    document.body.classList.toggle('phase-tournament',   val==='tournament');
  }
  if (key==='regOpen') renderRegisterPage();
  if (key==='showRegistered') renderParticipants();
  if (['paymentLink','paymentLinkLabel','paymentLink2','paymentLink2Label'].includes(key)) {
    renderRegisterPage(); renderParticipants();
  }
  if (key === 'regNote') renderRegisterPage();
  if (['eventDate','venue','price'].includes(key)) renderInfoCards();
  if (key === 'sport') renderAll();
  if (key === 'lang') { initLang(val); applyStatic(); renderAll(); }
  pushMeta(key);
}

function applyLogo(url) {
  const img=document.getElementById('logo-img');
  const letter=document.getElementById('logo-letter');
  const lm=document.getElementById('logo-mark');
  if (url) {
    img.src=url; img.style.display=''; if(letter)letter.style.display='none';
    // Show the logo as-is (no colored chip behind it, natural width)
    if(lm){ lm.style.background='transparent'; lm.style.boxShadow='none'; lm.style.width='auto'; lm.style.overflow='visible'; }
  } else {
    img.style.display='none'; if(letter)letter.style.display='';
    if(lm){ lm.style.background=meta.primaryColor||''; lm.style.boxShadow=''; lm.style.width=''; lm.style.overflow=''; }
  }
}

function updateKORuleField(ci, roundKey, field, val) {
  if (!categories[ci]) return;
  if (!categories[ci].cfg) categories[ci].cfg = structuredClone(DEF_CAT_CFG);
  if (!categories[ci].cfg.koRules) categories[ci].cfg.koRules = {};
  const lim = KO_LIM[field];
  const v = val === '' || val === null ? null : lim ? Math.min(lim[1], Math.max(lim[0], Math.round(Number(val)))) : Number(val);
  (roundKey === 'all' ? KO_STAGES : [roundKey]).forEach(k => {
    const r = categories[ci].cfg.koRules[k] || (categories[ci].cfg.koRules[k] = {...DEF_KO_RULES[k]});
    if (field === 'sets' && v !== 3) delete r.sets;
    else r[field] = v;
  });
  pushCategories();
  // Changing a stage's length shifts every slot after it — recompute the clock.
  const cid = categories[ci].id;
  // Coordinated grids use one slot for every stage; re-timing one category would collide.
  if (field === 'dur' && !coordBuild() && state[cid]?.sched.length) commitState(cid, () => assignSlotTimes(cid));
  if (roundKey === 'all' || field === 'sets' || lim && v !== Number(val)) renderSettings();
}

function updateCatName(ci, val) {
  if (!categories[ci]) return;
  categories[ci].name=val;
  pushCategories();
}
// ci = -1: a whole-tournament value (shared grid) — written to every category.
function updateCatCfg(ci, key, val) {
  const cats = ci < 0 ? categories : [categories[ci]].filter(Boolean);
  if (!cats.length) return;
  cats.forEach(c => { if (!c.cfg) c.cfg=structuredClone(DEF_CAT_CFG); c.cfg[key]=val; });
  if (ci < 0 && key === 'startTime' && meta.startTime) { meta.startTime = val; pushMeta('startTime'); }
  pushCategories(); retimeAfter(Math.max(ci, 0), key); renderSettings();
}
function adjCatCfg(ci, key, delta, min, max) {
  const c = categories[Math.max(ci, 0)];
  if (!c) return;
  const cur = ci < 0 && key === 'courts' ? coordCfg().COURTS : (c.cfg||DEF_CAT_CFG)[key]||min;
  updateCatCfg(ci, key, Math.min(max,Math.max(min,cur+delta)));
}


// New game minutes / break / start time re-time the built schedule: same rounds and
// courts, new clock; manually moved games keep their time.
function retimeAfter(ci, key) {
  if (!['gameDur', 'breakDur', 'startTime'].includes(key)) return;
  const coord = coordBuild();
  const cids = coord ? categories.map(c => c.id) : [categories[ci].id];
  if (!cids.some(id => state[id]?.sched.length)) return;
  commitState(cids, () => {
    const manual = cids.flatMap(id => allGamesOf(state[id]).filter(g => g.manual).map(g => [g, g.time]));
    if (!coord) cids.forEach(assignSlotTimes);
    else {
      const { SLOT, START } = coordCfg();
      const games = cids.flatMap(id => allGamesOf(state[id])).filter(g => g.si != null);
      const extra = {};
      if (meta.breakBeforeKO) {
        const P = Math.min(...cids.flatMap(id => allGamesOf(state[id]).filter(g => !(g.gi >= 0)).map(g => g.si ?? Infinity)));
        meta.breaks = P > 0 && P < Infinity ? [{ atTime: m2t(START + P*SLOT), minutes: meta.breakBeforeKO }] : [];
        extra['meta.breaks'] = meta.breaks;
      }
      const brs = (meta.breaks||[]).map(b => ({ at: t2m(b.atTime), min: b.minutes||0 })).sort((a,b) => a.at-b.at);
      games.forEach(g => { let t = START + g.si*SLOT; for (const b of brs) if (t >= b.at) t += b.min; g.time = m2t(t); });
      manual.forEach(([g, t]) => { g.time = t; });
      return extra;
    }
    manual.forEach(([g, t]) => { g.time = t; });
  });
}


async function addCategory() {
  const id='cat_'+Date.now();
  categories.push({ id, name:t('settings.newCategory'), cfg:structuredClone(DEF_CAT_CFG) });
  state[id]=emptyCat();
  await pushDoc('categories', categories, new FieldPath('state', id), catStateToFB(state[id]));
  renderSettings();
}
async function deleteCategory(ci) {
  if (meta.phase === 'tournament') { alert(t('settings.cantDeleteCat')); return; }
  const cat = categories[ci];
  if (!cat || !await askConfirm(t('settings.confirmDeleteCat', { name: fsi(cat.name) }), t('common.delete'))) return;
  const i = categories.findIndex(c => c.id === cat.id);
  if (i < 0) return;
  categories.splice(i,1);
  delete state[cat.id];
  await pushDoc('categories', categories, new FieldPath('state', cat.id), deleteField());
  renderSettings(); renderAll();
}

async function resetAllScores() {
  if (!superAdmin||!await askConfirm(t('settings.confirmResetScores'), t('common.reset'))) return;
  unsavedGames.clear(); mirrorUnsaved();
  await commitState(categories.map(c => c.id), () => {
    categories.forEach(cat => {
      const cs=state[cat.id];
      cs.sched.forEach(g=>{g.sa='';g.sb='';});
      cs.ko.forEach(r=>r.forEach(g=>{g.sa='';g.sb='';}));
      updateKOForCat(cat.id);
    });
  });
  renderAll();
}

// ============ NAV ============
function goPage(p) {
  if (p==='registrations' && !admin) return;
  if (p==='build' && (!admin || (meta.phase !== 'registration' && meta.phase !== 'built'))) return;
  if (p==='settings' && !superAdmin) return;
  document.querySelectorAll('.pg').forEach(e=>e.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(e=>{ e.classList.remove('on'); e.removeAttribute('aria-current'); });
  const pageEl=document.getElementById('page-'+p);
  if (!pageEl) return;
  pageEl.classList.add('on');
  history.replaceState(null, '', '#' + p);
  const tab=document.getElementById('tab-'+p);
  if (tab) { tab.classList.add('on'); tab.setAttribute('aria-current', 'page'); }
  renderCatFilters();
  if (p==='register')       renderRegisterPage();
  if (p==='participants')   renderParticipants();
  if (p==='registrations')  renderRegistrations();
  if (p==='build')          renderBuildPage();
  if (p==='standings')      renderStandings();
  if (p==='schedule')       { renderStats(); renderCourtFilter(); renderScheduleContent(); scrollBelowSticky(document.querySelector('#schedule-content .tblock.has-open')); }
  if (p==='bracket')        renderBracket();
  if (p==='settings')       renderSettings();
}
function scrollBelowSticky(el) {
  if (!el) return;
  const top = el.getBoundingClientRect().top + scrollY - (document.getElementById('sticky-block')?.offsetHeight || 0) - 8;
  if (top > scrollY + 40) scrollTo({ top });
}

// Fade the nav's end edge while more tabs are hidden past it (scroll hint).
function updateNavFade() {
  const nav = document.getElementById('main-nav');
  if (nav) nav.classList.toggle('fade-end', nav.scrollWidth - nav.clientWidth - Math.abs(nav.scrollLeft) > 2);
}

function rerender() {
  const y = scrollY;
  renderCatFilters();
  const pages=['register','participants','registrations','build','standings','schedule','bracket','settings'];
  const active=pages.find(p=>{
    const el=document.getElementById('page-'+p);
    return el&&el.classList.contains('on');
  });
  if (active==='standings')     renderStandings();
  if (active==='schedule')      { renderStats(); renderCourtFilter(); renderScheduleContent(); }
  if (active==='bracket')       renderBracket();
  // Our own write's server ack re-renders too: never rebuild Settings under the cursor.
  if (active==='settings' && !document.getElementById('page-settings')?.contains(document.activeElement)) renderSettings();
  if (active==='registrations') renderRegistrations();
  if (active==='build')         renderBuildPage();
  if (active==='participants')  renderParticipants();
  if (active==='register')      renderRegisterPage();
  if (scrollY !== y) scrollTo(0, y);
}

function renderSponsorBar() {
  const bar = document.getElementById('sponsor-bar');
  if (!bar) return;
  const logos = meta.sponsorLogos;
  if (!logos || !logos.length) { bar.classList.add('h'); return; }
  bar.classList.remove('h');
  bar.innerHTML = logos.map(l =>
    l.url
      ? `<img class="sponsor-logo" src="${escH(l.url)}" alt="${escH(l.alt||'')}" title="${escH(l.alt||'')}"${l.imgStyle?` style="${escH(l.imgStyle)}"`:''}/>`
      : `<span class="sponsor-text">${escH(l.alt||'')}</span>`
  ).join('');
}

// Firestore echoes our own writes back (local echo + server ack), each of which
// re-renders and rebuilds inputs — dropping focus mid-typing. Preserve the
// focused field + caret across every re-render so typing is never interrupted.
function _focusSnapshot() {
  const ae = document.activeElement;
  if (!ae || !/^(INPUT|TEXTAREA)$/.test(ae.tagName)) return null;
  let sel = null;
  if (ae.id) sel = '#' + ((window.CSS && CSS.escape) ? CSS.escape(ae.id) : ae.id);
  else if (ae.placeholder) sel = ae.tagName.toLowerCase() + '[placeholder="' + ae.placeholder.replace(/"/g,'\\"') + '"]';
  if (!sel) return null;
  let s = null, e = null;
  try { s = ae.selectionStart; e = ae.selectionEnd; } catch(_) {}
  return { sel, s, e };
}
function _focusRestore(f) {
  if (!f) return;
  let el = null;
  try { el = document.querySelector(f.sel); } catch(_) {}
  if (!el || el === document.activeElement) return;
  try {
    el.focus({ preventScroll: true });
    if (f.s != null && el.setSelectionRange) el.setSelectionRange(f.s, f.e);
  } catch(_) {}
}
function renderAll() {
  const _f = _focusSnapshot();
  renderAllInner();
  _focusRestore(_f);
}
// Everything outside the pages: theme, logo, header, phase classes, sponsors, admin bar.
function renderChrome() {
  applyTheme(meta.primaryColor, meta.secondaryColor);
  applyGroupColors();
  applyLogo(meta.logoUrl);
  document.getElementById('header-name').textContent = meta.name||t('common.tournament');
  document.title = meta.name||t('common.appName');
  document.querySelectorAll('.langsw__b').forEach(b => {
    b.classList.toggle('is-on', b.dataset.lang === getLang());
    b.setAttribute('aria-pressed', b.dataset.lang === getLang());
  });
  const ll=document.getElementById('logo-letter');
  if (ll) ll.textContent=(meta.name||'T')[0].toUpperCase();

  document.body.classList.toggle('phase-registration', meta.phase === 'registration');
  document.body.classList.toggle('phase-built',        meta.phase === 'built');
  document.body.classList.toggle('phase-tournament',   meta.phase === 'tournament');

  renderSponsorBar();
  renderInfoCards();
  refreshAdmin();
}
function renderAllInner() {
  renderChrome();
  renderCatFilters();
  renderRegisterPage();
  renderParticipants();
  renderStandings();
  renderStats();
  renderCourtFilter();
  renderScheduleContent();
  renderBracket();
  if (superAdmin && !document.getElementById('page-settings')?.contains(document.activeElement)) renderSettings();
}

// ============ EXPOSE GLOBALS ============
Object.assign(window, {
  adminClick, selectLoginRole, tryLogin, closeLogin, saveSecurePw,
  openStartModal, closeStartModal, confirmStartTournament,
  goPage, setCat, setCourt,
  submitRegistration, cancelMyRegistration, registerAnother, setRegStatus, setRegPaid, setRegFilter,
  setRegPaidFilter, setRegSearch, exportRegistrationsCSV, selectRegCat,
  openAddPair, closeAddPair, saveAddPair,
  buildTournament, undoLastBuild, shuffleBuildRoster, moveBuildItem,
  onDragStart, onDragEnd, onDragOver, onDrop, onListDragOver, onListDrop,
  openEditTeam, closeEdit, saveEdit, deleteTeam, openEditReg, approveAllShown,
  editBuildItem, deleteBuildItem,
  setGS, setKS, filterSchedule,
  openGameSheet, closeSheet, saveMove, editPairFromSheet, techLoss, forceSave, withdrawTeam, saveLatePair,
  openDelay, shiftFrom,
  updateMeta, updateCatName, updateCatCfg, adjCatCfg,
  addCategory, deleteCategory, resetAllScores,
  updateSponsorLogo, removeSponsorLogo, addSponsorLogo, uploadSponsorLogo, removeLogo, renderSettings,
  updateCatColor, renameGroup, moveTeam,
  updateGroupColor, updateBgColor,
  updateKORuleField, setLang,
  addPlayerToDB, removePlayerFromDB, importPlayersFromTournament
});

// ============ PLAYER DATABASE ============
async function loadPlayerDB() {
  if (secure) return;
  try {
    PLAYERS_REF = doc(db, 'players', 'global');
    const snap = await getDoc(PLAYERS_REF);
    playerDB = snap.exists() ? (snap.data().list || []) : [];
  } catch(e) { playerDB = []; }
  updatePlayerDatalist();
}

function updatePlayerDatalist() {
  const dl = document.getElementById('player-datalist');
  if (!dl) return;
  dl.innerHTML = playerDB.map(p => `<option value="${escH(p.name)}">${escH(p.name)}${p.phone?' ('+escH(p.phone)+')':''}</option>`).join('');
}

async function savePlayerDB() {
  if (!PLAYERS_REF) PLAYERS_REF = doc(db, 'players', 'global');
  await setDoc(PLAYERS_REF, { list: playerDB, updatedAt: serverTimestamp() });
  updatePlayerDatalist();
}

async function addPlayerToDB(name, phone) {
  name = name?.trim(); if (!name || secure) return;
  if (!playerDB.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    playerDB.push({ name, phone: phone||'' });
    await savePlayerDB();
    renderSettings();
  }
}

async function removePlayerFromDB(idx) {
  playerDB.splice(idx, 1);
  await savePlayerDB();
  renderSettings();
}

function renderSecurePwSection(container) {
  if (adminLevel !== 2) return;
  const sec = document.createElement('div');
  sec.className = 'sett-section';
  sec.innerHTML = `<div class="sett-section-title">${t('settings.securePw')}</div>
    <p class="sett-desc">${t('settings.securePwDesc')}</p>
    ${['admin', 'master'].map(role => `<div class="sett-row">
      <div class="sett-label"><span class="sett-name">${t(role === 'master' ? 'admin.roleMaster' : 'admin.roleAdmin')}</span></div>
      <div class="sett-ctrl">
        <input class="text-inp" id="spw-${role}" type="password" dir="ltr" autocomplete="new-password" style="width:160px"/>
        <button class="add-cat-btn" onclick="saveSecurePw('${role}')">${t('settings.pwSave')}</button>
      </div></div>`).join('')}`;
  container.appendChild(sec);
}

async function saveSecurePw(role) {
  const inp = document.getElementById('spw-' + role);
  if (inp.value.length < 6) { toast(t('settings.securePwDesc')); return; }
  try {
    await callFn('setTournamentPassword', { tId, role, password: inp.value });
    inp.value = '';
    toast(t('settings.pwSaved'));
  } catch(e) { toast(t(e.code === 'functions/permission-denied' ? 'admin.noAccess' : 'errors.saveFailed')); }
}

function renderPlayerDBSection(container) {
  const sec = document.createElement('div');
  sec.className = 'sett-section';
  sec.innerHTML = `
    <div class="sett-section-title">${t('settings.players')}</div>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <input class="text-inp" id="new-player-name" dir="auto" style="flex:1;min-width:120px" placeholder="${t('settings.playerNamePh')}"/>
      <input class="text-inp" id="new-player-phone" type="tel" dir="ltr" style="width:130px" placeholder="${t('settings.playerPhonePh')}"/>
      <button class="add-cat-btn" onclick="addPlayerToDB(document.getElementById('new-player-name').value,document.getElementById('new-player-phone').value);document.getElementById('new-player-name').value='';document.getElementById('new-player-phone').value=''">${t('common.addPlus')}</button>
    </div>
    <div style="margin-bottom:10px">
      <button class="add-cat-btn" onclick="importPlayersFromTournament()">${t('settings.importPlayers')}</button>
      <span style="font-size:11px;color:var(--text3);margin-inline-start:8px">${t('settings.playersCount', { n: playerDB.length })}</span>
    </div>
    <div class="player-db-list">${playerDB.length
      ? playerDB.map((p,i) => `
        <div class="player-db-row">
          <span class="player-db-name">${dnH(p.name)}</span>
          <span class="player-db-phone">${escH(p.phone||'')}</span>
          <button class="team-del" onclick="removePlayerFromDB(${i})" title="${t('common.remove')}" aria-label="${t('common.remove')}">✕</button>
        </div>`).join('')
      : `<p class="sett-empty-note">${t('settings.noPlayers')}</p>`}
    </div>`;
  container.appendChild(sec);
}

// Import all individual players from this tournament's groups into the DB
async function importPlayersFromTournament() {
  let added = 0;
  categories.forEach(cat => {
    const cs = state[cat.id];
    if (!cs) return;
    (cs.groups||[]).forEach(grp => {
      grp.teams.forEach(pairName => {
        // Split pair name into individual players
        const parts = pairName.includes('/') ? pairName.split('/').map(s=>s.trim()) : [pairName];
        parts.forEach(name => {
          if (name && !playerDB.find(p => normName(p.name) === normName(name))) {
            playerDB.push({ name, phone: '' });
            added++;
          }
        });
      });
    });
  });
  if (added > 0) {
    await savePlayerDB();
    renderSettings();
    alert(t('settings.imported', { n: added }));
  } else {
    alert(t('settings.allImported'));
  }
}

// Auto-add both players of a new pair to the DB
async function autoAddPairToDB(name) {
  if (!name) return;
  const parts = name.includes('/') ? name.split('/').map(s=>s.trim()) : [name];
  for (const p of parts) {
    if (p && !playerDB.find(x => normName(x.name) === normName(p))) {
      playerDB.push({ name: p, phone: '' });
    }
  }
  await savePlayerDB();
  updatePlayerDatalist();
}

// ============ BOOT ============
// Pinch zoom is allowed on purpose (accessibility: small names / scores).

// Don't lose a debounced score when the scorer locks the phone / leaves the page.
document.addEventListener('visibilitychange', () => { if (document.hidden) flushScoreWrites(); });
window.addEventListener('pagehide', () => flushScoreWrites());
window.addEventListener('online', () => { setSyncStatus(true); flushScoreWrites(); });
window.addEventListener('offline', () => { setSyncStatus(false); if (unsavedGames.size) toast(t('sync.unsaved', { n: unsavedGames.size })); });

window.addEventListener('langchange', () => { applyStatic(); renderAll(); setSyncStatus(); });
window.addEventListener('resize', updateNavFade);
document.getElementById('main-nav')?.addEventListener('scroll', updateNavFade, { passive: true });

document.addEventListener('DOMContentLoaded', async () => {
  initLang();
  applyStatic();
  document.querySelectorAll('.print-link').forEach(a => a.href = a.getAttribute('href').split('?')[0] + location.search);
  const ok = await loadTournament();
  if (!ok) return;
  initLang(meta.lang);
  applyStatic();

  activeCat = null;
  await restoreLogin();
  firebaseReady = true;
  if (admin) { restoreUnsaved(); flushScoreWrites(); }
  loadPlayerDB(); // load player database in background
  document.getElementById('view-loading').classList.add('h');
  document.getElementById('view-app').classList.remove('h');

  const si = document.getElementById('sched-search');
  if (si) si.value = myPairQ;
  renderAll();

  const h = location.hash.slice(1);
  goPage(/^\w+$/.test(h) && document.getElementById('tab-' + h)?.offsetParent ? h
    : meta.phase === 'tournament' ? 'schedule' : meta.phase === 'built' ? 'standings' : admin ? 'registrations' : 'register');
});
