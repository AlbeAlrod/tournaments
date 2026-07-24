import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, addDoc, getDocs, updateDoc, deleteDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

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

// ============ URL PARAM ============
const tId = new URLSearchParams(location.search).get('t');

// ============ STATE ============
let meta = { name:'', logoUrl:'', primaryColor:'#6B21A8', secondaryColor:'#7C3AED',
  paymentLink:'', paymentLinkLabel:'', paymentLink2:'', paymentLink2Label:'',
  regNote:'', sponsorLogos: [],
  groupColors: [],   // [gi0,gi1,gi2,gi3] — empty = use defaults
  bgColor: '',       // override body background — empty = auto from primary
  phase:'registration', regOpen:true, showRegistered:true };
let categories = [];   // [{id, name, cfg}]
let state = {};        // {[catId]: {roster:[], groups:[], sched:[], ko:[]}}
let registrations = [];// [{id, p1, p2, phone, category, status, paid, createdAt}]

let adminLevel = 0;    // 0=view  1=admin(scores in tournament)  2=manager(full in reg + scores)
let admin = false;
let superAdmin = false;
let loginRole = 'admin';

let activeCat = null;  // selected category id for tournament views
let regFilter = 'all'; // pending|approved|rejected|all
let schedFilter = [];
let activeCourt = 'all';
let applyingRemote = false;
let skipNextSnapshot = 0;
let firebaseReady = false;

let TREF = null;
let REGS_REF = null;
let PLAYERS_REF = null;
let playerDB = []; // [{name, phone}]

// ============ HTML ESCAPE ============
const escH = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ============ SHA-256 ============
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ============ DISPLAY NAME — removes "ו" connector between partner names ============
// "תום ומוריאל" → "תום מוריאל"  |  "מרג' ואילי" → "מרג' אילי"
const dn = s => {
  if (!s || s.startsWith('Winner') || /^[A-Z]\d+$/.test(s)) return s;
  return s.replace(/\sו([^\s])/g, ' $1');
};
const dnH = s => escH(dn(s));

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
  courts: 2, gameDur: 30, breakDur: 0, numGroups: 2, advPerGroup: 2,
  pointsToWin: 21, sets: 1, pointsThirdSet: 15, startTime: '08:00'
};

// ============ SYNC ============
function setSyncStatus(ok) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.className = 'sync-dot ' + (ok ? 'sync-ok' : 'sync-err');
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
  return { roster: cs.roster||[], groups: cs.groups||[], sched: cs.sched||[], ko: koToFB(cs.ko||[]) };
}
function catStateFromFB(data) {
  return {
    roster: data.roster||[],
    groups: data.groups||[],
    sched:  data.sched||[],
    ko:     koFromFB(data.ko)
  };
}

async function pushToCloud() {
  if (!firebaseReady || applyingRemote || !TREF) return;
  const stateObj = {};
  Object.entries(state).forEach(([cid, cs]) => { stateObj[cid] = catStateToFB(cs); });
  skipNextSnapshot++;
  try {
    await setDoc(TREF, {
      meta, categories,
      state: stateObj,
      updatedAt: serverTimestamp()
    }, { merge: true });
    setSyncStatus(true);
  } catch(e) {
    skipNextSnapshot--;
    console.error('Push error', e);
    setSyncStatus(false);
  }
}

async function pushMetaOnly() {
  if (!TREF) return;
  // Guard like pushToCloud: without this our OWN write comes back through
  // onSnapshot → renderAll() → the focused input is rebuilt and you lose focus
  // after every keystroke (tournament name / category names).
  skipNextSnapshot++;
  try {
    await setDoc(TREF, { meta, updatedAt: serverTimestamp() }, { merge: true });
    setSyncStatus(true);
  } catch(e) { skipNextSnapshot--; setSyncStatus(false); }
}

// ============ LOAD TOURNAMENT ============
async function loadTournament() {
  if (!tId) {
    document.getElementById('view-loading').classList.add('h');
    document.getElementById('view-none').classList.remove('h');
    return false;
  }
  TREF = doc(db, 'tournaments', tId);
  REGS_REF = collection(db, 'tournaments', tId, 'registrations');

  const snap = await getDoc(TREF);
  if (!snap.exists()) {
    applyingRemote = true;
    const initData = {
      meta: { ...meta },
      categories: [],
      state: {},
      updatedAt: serverTimestamp()
    };
    await setDoc(TREF, initData);
    applyingRemote = false;
  } else {
    const data = snap.data();
    if (data.meta) meta = { ...meta, ...data.meta };
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

  // Load registrations
  await loadRegistrations();

  // Live listener
  onSnapshot(TREF, snap => {
    if (!snap.exists() || applyingRemote) return;
    if (skipNextSnapshot > 0) { skipNextSnapshot--; return; }
    applyingRemote = true;
    const data = snap.data();
    if (data.meta) meta = { ...meta, ...data.meta };
    if (data.categories) categories = data.categories;
    if (data.state) {
      Object.entries(data.state).forEach(([cid, cs]) => {
        state[cid] = catStateFromFB(cs);
      });
    }
    categories.forEach(cat => {
      if (!state[cat.id]) state[cat.id] = { roster:[], groups:[], sched:[], ko:[] };
    });
    applyingRemote = false;
    applyTheme(meta.primaryColor, meta.secondaryColor);
    renderAll();
    setSyncStatus(true);
  });

  return true;
}

async function loadRegistrations() {
  if (!REGS_REF) return;
  try {
    const snap = await getDocs(query(REGS_REF, orderBy('createdAt', 'asc')));
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    const snap = await getDocs(REGS_REF);
    registrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
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

// White or dark text on a colored background (e.g. buttons, group headers)
function onColor(bgHex) {
  return contrast('#FFFFFF', bgHex) >= 4.5 ? '#FFFFFF' : '#1a1a1a';
}

function applyTheme(primary, secondary) {
  primary   = primary   || '#6B21A8';
  secondary = secondary || primary;

  const [r1,g1,b1] = hexToRgb(primary);
  const [h1,s1,l1] = hexToHsl(primary);
  const [h2,s2,l2] = hexToHsl(secondary);

  // ── Backgrounds: barely-there tint — feels white, reads as brand ──
  const bg   = hslToHex(h1, Math.min(s1 * 0.07, 6),  98);
  const bg3  = hslToHex(h1, Math.min(s1 * 0.13, 11), 95);
  const surf = hslToHex(h1, Math.min(s1 * 0.22, 18), 91);

  // ── Text: deep tones grounded in primary hue, forced WCAG contrast ──
  const rawText  = hslToHex(h1, Math.min(s1 * 0.30, 28), 10);
  const rawText2 = hslToHex(h1, Math.min(s1 * 0.50, 44), 22);
  const rawText3 = hslToHex(h1, Math.min(s1 * 0.60, 54), 42);
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
  const primaryText   = readable(primary,   '#FFFFFF', 3.5);
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
    refreshAdmin(); rerender(); return;
  }
  loginRole = 'admin';
  updateRoleButtons();
  document.getElementById('pw-modal').classList.remove('h');
  setTimeout(() => document.getElementById('pw-inp').focus(), 80);
}

function selectLoginRole(role) {
  loginRole = role;
  updateRoleButtons();
  document.getElementById('pw-inp').focus();
}

function updateRoleButtons() {
  const on  = `flex:1;padding:10px 6px;border-radius:var(--rs);border:2px solid var(--primary);background:var(--primary);color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;cursor:pointer`;
  const off = `flex:1;padding:10px 6px;border-radius:var(--rs);border:2px solid var(--border2);background:transparent;color:var(--primary);font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;cursor:pointer`;
  document.getElementById('role-btn-admin')?.setAttribute('style',   loginRole==='admin'  ? on : off);
  document.getElementById('role-btn-master')?.setAttribute('style', loginRole==='master' ? on : off);
}

async function tryLogin() {
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
    adminLevel = loginRole === 'master' ? 2 : 1;
    admin      = true;
    superAdmin = adminLevel === 2;
    closeLogin(); refreshAdmin(); rerender();
  } else {
    document.getElementById('pw-err').classList.remove('h');
    document.getElementById('pw-inp').value = '';
    document.getElementById('pw-inp').focus();
  }
}

function closeLogin() {
  document.getElementById('pw-modal').classList.add('h');
  document.getElementById('pw-inp').value = '';
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
  if (txt) txt.textContent = adminLevel===2 ? 'Master ✓' : adminLevel===1 ? 'Admin ✓' : 'Admin';
  if (btn) btn.classList.toggle('on', admin);
  const syncDot = document.getElementById('sync-indicator');
  if (syncDot) syncDot.classList.toggle('h', !admin);
  if (bar) bar.className = 'mode-bar ' + (admin ? 'mode-admin' : 'mode-view');
  const adminBar = document.getElementById('admin-bar');
  if (adminBar) adminBar.classList.toggle('mode-admin', admin);
  if (mtxt) {
    if (!admin) mtxt.textContent = 'View only — tap Admin to manage';
    else if (meta.phase==='registration') mtxt.textContent = adminLevel===2 ? 'Master mode — full access' : 'Admin mode — approvals & add players';
    else if (meta.phase==='built') mtxt.textContent = adminLevel===2 ? 'Master mode — tournament built' : 'Admin mode — edit roster';
    else mtxt.textContent = 'Admin mode — score entry';
  }
  // Hide Register tab when admin is logged in (registration phase)
  const regTab = document.getElementById('tab-register');
  if (regTab) regTab.classList.toggle('h', regManager);
  // Hide Settings tab in tournament phase (even from master)
  const settingsTab = document.getElementById('tab-settings');
  if (settingsTab) settingsTab.classList.toggle('h', !superAdmin || meta.phase === 'tournament');
  // Auto-navigate away from pages that don't belong in current phase
  if (regManager && document.getElementById('page-register')?.classList.contains('on')) {
    goPage('registrations');
  }
  if (builtManager) {
    const onRegOnlyPage = ['register','registrations'].some(p =>
      document.getElementById('page-'+p)?.classList.contains('on'));
    if (onRegOnlyPage) goPage('standings');
  }
  if (admin && meta.phase === 'tournament') {
    const onRegPage = ['registrations','build'].some(p =>
      document.getElementById('page-'+p)?.classList.contains('on'));
    if (onRegPage) goPage('standings');
  }
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
  meta.phase = 'tournament';
  await pushMetaOnly();
  document.body.classList.remove('phase-registration');
  document.body.classList.add('phase-tournament');
  refreshAdmin();
  renderAll();
  goPage('standings');
}

// ============ REGISTRATION ============
async function submitRegistration() {
  const p1   = document.getElementById('frm-p1').value.trim();
  const p2   = document.getElementById('frm-p2').value.trim();
  const phone = document.getElementById('frm-phone').value.trim();
  const catId = document.querySelector('#frm-cat-wrap .cat-pill.on')?.dataset.value || '';
  const err = document.getElementById('frm-err');
  const ok  = document.getElementById('frm-ok');
  err.classList.add('h'); ok.classList.add('h');
  if (!p1) { err.textContent = 'Player 1 name is required.'; err.classList.remove('h'); return; }
  if (!catId) { err.textContent = 'Please select a category.'; err.classList.remove('h'); return; }
  try {
    await addDoc(REGS_REF, {
      p1, p2, phone, category: catId,
      status: 'pending', paid: false,
      createdAt: serverTimestamp()
    });
    document.getElementById('frm-p1').value = '';
    document.getElementById('frm-p2').value = '';
    document.getElementById('frm-phone').value = '';
    ok.classList.remove('h');
    if (categories.length !== 1)
      document.querySelectorAll('#frm-cat-wrap .cat-pill').forEach(b => b.classList.remove('on'));
  } catch(e) {
    err.textContent = 'Submission failed. Please try again.';
    err.classList.remove('h');
  }
}

async function setRegStatus(id, status) {
  if (!admin) return;
  try {
    if (status === 'rejected') {
      if (!confirm('Reject and permanently remove this registration?')) return;
      // Hard delete — also remove from build roster if present
      const reg = registrations.find(r => r.id === id);
      if (reg) {
        const catId = reg.category;
        const name = reg.p1 + (reg.p2 ? ' / ' + reg.p2 : '');
        if (state[catId]?.roster) {
          const ri = state[catId].roster.indexOf(name);
          if (ri !== -1) { state[catId].roster.splice(ri, 1); await pushToCloud(); }
        }
      }
      await deleteDoc(doc(db, 'tournaments', tId, 'registrations', id));
      registrations = registrations.filter(r => r.id !== id);
    } else {
      const r = registrations.find(r => r.id === id);
      const wasRejected = r?.status === 'rejected';
      await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { status });
      if (r) {
        r.status = status;
        // Re-approve a rejected pair → add back to build roster
        if (status === 'approved' && wasRejected) {
          const catId = r.category;
          const name = r.p1 + (r.p2 ? ' / ' + r.p2 : '');
          if (state[catId]?.roster && !state[catId].roster.includes(name)) {
            state[catId].roster.push(name);
            await pushToCloud();
          }
        }
      }
    }
    renderRegistrations();
    renderParticipants();
    renderBuildPage();
  } catch(e) { alert('Error updating status'); }
}

async function setRegPaid(id, paid) {
  if (!admin) return;
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { paid });
    const r = registrations.find(r => r.id === id);
    if (r) r.paid = paid;
    renderRegistrations();
  } catch(e) {}
}

function selectRegCat(btn) {
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
}

function setRegFilter(f) {
  regFilter = f;
  ['all','pending','approved','rejected'].forEach(k => {
    document.getElementById('rf-' + k)?.classList.toggle('on', k === f);
  });
  renderRegistrations();
}

function renderRegistrations() {
  const el = document.getElementById('registrations-list');
  if (!el) return;
  let list = [...registrations];
  if (regFilter !== 'all') list = list.filter(r => r.status === regFilter);
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>No registrations</h3></div>`;
    return;
  }
  el.innerHTML = list.map(r => {
    const cat = categories.find(c => c.id === r.category);
    const catName = cat ? cat.name : r.category;
    return `<div class="reg-row status-${r.status}">
      <div class="reg-info">
        <div class="reg-name">${escH(r.p1)}${r.p2 ? ' / ' + escH(r.p2) : ''}</div>
        <div class="reg-meta">${escH(catName)} · ${new Date(r.createdAt?.seconds*1000||0).toLocaleDateString()}</div>
        <div class="reg-phone">${escH(r.phone||'—')}</div>
      </div>
      <span class="status-badge badge-${r.status}">${r.status}</span>
      <div class="reg-actions">
        ${r.status !== 'approved' ? `<button class="reg-btn approve" onclick="setRegStatus('${r.id}','approved')">Approve</button>` : ''}
        ${r.status === 'approved'  ? `<button class="reg-btn" onclick="setRegStatus('${r.id}','pending')">Undo</button>` : ''}
        <button class="reg-btn reject" onclick="setRegStatus('${r.id}','rejected')" title="Permanently remove">Delete</button>
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
  const approved = registrations.filter(r => r.status === 'approved');
  if (!approved.length) {
    el.innerHTML = `<div class="empty"><h3>No approved participants yet</h3></div>`;
    return;
  }
  const byCat = {};
  categories.forEach(c => { byCat[c.id] = []; });
  approved.forEach(r => {
    if (!byCat[r.category]) byCat[r.category] = [];
    byCat[r.category].push(r);
  });
  el.innerHTML = categories.map(cat => {
    const list = byCat[cat.id] || [];
    if (!list.length) return '';
    return `<div class="part-cat">
      <div class="part-cat-title">${escH(cat.name)}</div>
      <div class="part-grid">${list.map((r,i) => `
        <div class="part-card">
          <span class="part-num">${i+1}</span>
          <span class="part-name">${dnH(r.p1)}${r.p2 ? ' / '+dnH(r.p2) : ''}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderPayLink(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const links = [
    { url: meta.paymentLink,  label: meta.paymentLinkLabel  || 'Payment Link'   },
    { url: meta.paymentLink2, label: meta.paymentLink2Label || 'Payment Link 2' },
  ].filter(l => /^https?:\/\//i.test(l.url || ''));   // only real http(s) links (blocks javascript: etc.)

  if (!links.length) { wrap.className = 'pay-section h'; wrap.innerHTML = ''; return; }

  wrap.className = 'pay-section';
  wrap.innerHTML = `
    <span class="pay-label">Payment</span>
    <div class="pay-links">
      ${links.map(l => `<a class="pay-link-btn" href="${escH(l.url)}" target="_blank" rel="noopener">${escH(l.label)}</a>`).join('')}
    </div>`;
}

function renderRegisterPage() {
  const closedMsg = document.getElementById('reg-closed-msg');
  const formWrap  = document.getElementById('reg-form-wrap');
  const sub       = document.getElementById('reg-subtitle');
  if (!meta.regOpen) {
    closedMsg?.classList.remove('h');
    if (formWrap) formWrap.style.display = 'none';
  } else {
    closedMsg?.classList.add('h');
    if (formWrap) formWrap.style.display = '';
  }
  if (sub) sub.textContent = meta.name ? `Register for ${meta.name}` : '';
  const catWrap = document.getElementById('frm-cat-wrap');
  if (catWrap) {
    catWrap.innerHTML = categories.map(c =>
      `<button type="button" class="cat-pill" data-value="${escH(c.id)}" onclick="selectRegCat(this)">${escH(c.name)}</button>`
    ).join('');
    if (categories.length === 1) catWrap.querySelector('.cat-pill')?.classList.add('on');
    // Hide category row when only one option
    const catRow = catWrap.closest('.form-row');
    if (catRow) catRow.style.display = categories.length === 1 ? 'none' : '';
  }
  const noteEl = document.getElementById('reg-note');
  if (noteEl) {
    noteEl.textContent = meta.regNote || '';
    noteEl.classList.toggle('h', !meta.regNote);
  }
  renderPayLink('reg-pay-wrap');
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
    banner.style.cssText = 'margin-bottom:16px;padding:12px 16px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);border-radius:var(--rs);font-size:13px;color:var(--text)';
    banner.textContent = '✓ הטורניר בנוי — ניתן עדיין לערוך זוגות ולבנות מחדש';
    el.appendChild(banner);
  }

  categories.forEach(cat => {
    if (!state[cat.id]) state[cat.id] = { roster:[], groups:[], sched:[], ko:[] };
    const cs = state[cat.id];
    if (!cs.roster.length) {
      cs.roster = registrations.filter(r => r.status === 'approved' && r.category === cat.id)
        .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));
    }
    const roster = cs.roster;

    const div = document.createElement('div');
    div.className = 'build-cat';
    const _bci = categories.indexOf(cat);
    div.dataset.ci = _bci;
    const _bDefColors = ['','#D97706','#0891B2','#EA580C'];
    const _bColor = cat.color || _bDefColors[_bci] || '';
    const _bOn = _bColor && _bColor.startsWith('#') ? onColor(_bColor) : '';
    if (_bColor) { div.style.setProperty('--cat-color', _bColor); }
    if (_bOn)    { div.style.setProperty('--cat-on-color', _bOn); }
    div.innerHTML = `
      <div class="build-cat-head">
        <span class="build-cat-name">${escH(cat.name)}</span>
        <span class="build-cat-count">${roster.length} pairs</span>
      </div>
      <div class="build-list" id="blist-${cat.id}" data-cat="${cat.id}"
        ondragover="onListDragOver(event)" ondrop="onListDrop(event,'${cat.id}')">
        ${roster.map((name,i) => buildItem(cat.id, name, i)).join('')}
      </div>
      <div class="build-foot">
        <button class="build-btn" onclick="buildTournament('${cat.id}')">${meta.phase === 'built' ? '↺ Rebuild' : '▶ Build Tournament'}</button>
        <button class="build-shuffle" onclick="shuffleBuildRoster('${cat.id}')">Shuffle</button>
        <button class="build-add-pair" onclick="openAddPair('${cat.id}')">+ Add Pair</button>
      </div>`;
    el.appendChild(div);
    setupDragDrop(cat.id);
  });

  // Start Tournament button — visible to any admin in registration / built phase
  const startWrap = document.createElement('div');
  startWrap.style.cssText = 'margin-top:24px;padding:16px;text-align:center;border-top:1px solid var(--border)';
  const startNote = meta.phase === 'built'
    ? 'הטורניר בנוי ומוכן. לחצי Start בתחילת התחרות.<br>לאחר מכן לא ניתן לשנות הגדרות.'
    : 'בני תחילה את כל הקטגוריות, ולאחר מכן הפעילי את הטורניר.';
  startWrap.innerHTML = `
    <p style="font-size:13px;color:var(--text3);margin-bottom:12px;line-height:1.5">${startNote}</p>
    <button class="gen-btn" onclick="openStartModal()" ${meta.phase !== 'built' ? 'disabled style="opacity:.45;cursor:not-allowed"' : ''}>▶ Start Tournament</button>`;
  el.appendChild(startWrap);
}

function buildItem(catId, name, i) {
  return `<div class="build-item" draggable="true" data-cat="${catId}" data-idx="${i}"
    ondragstart="onDragStart(event)" ondragover="onDragOver(event)"
    ondrop="onDrop(event,'${catId}')" ondragend="onDragEnd(event)">
    <span class="build-rank">${i+1}</span>
    <span class="build-name">${dnH(name)}</span>
    <button class="gedit-btn" onclick="editBuildItem('${catId}',${i})" title="Edit">Edit</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},-1)" title="Up">↑</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},1)" title="Down">↓</button>
    <button class="team-del" onclick="deleteBuildItem('${catId}',${i})" title="Remove">✕</button>
  </div>`;
}

function editBuildItem(catId, idx) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const name = state[catId]?.roster[idx] || '';
  editTarget = { catId, buildIdx: idx, oldName: name };
  const parts = name.split('/').map(s => s.trim());
  document.getElementById('edit-p1').value = parts[0] || '';
  document.getElementById('edit-p2').value = parts[1] || '';
  document.getElementById('edit-modal-title').textContent = 'Edit Pair';
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
  if (!confirm(name ? `Remove "${name}" from the tournament?` : 'Remove this pair?')) return;
  if (name) {
    const parts = name.split(' / ').map(s => s.trim());
    const p1 = parts[0], p2 = parts[1] || '';
    const reg = registrations.find(r =>
      r.category === catId && r.p1 === p1 && (r.p2 || '') === p2 && r.status === 'approved'
    );
    if (reg) {
      try {
        await updateDoc(doc(db, 'tournaments', tId, 'registrations', reg.id), { status: 'rejected' });
        reg.status = 'rejected'; // soft-reject: stays in Firestore, visible in Registrations
      } catch(e) { console.error('Could not update registration status', e); }
    }
  }
  state[catId].roster.splice(idx, 1);
  pushToCloud();
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
    const cs = state[srcCatId];
    if (!cs) return;
    const roster = [...cs.roster];
    const [moved] = roster.splice(fromIdx, 1);
    roster.splice(toIdx, 0, moved);
    cs.roster = roster;
    pushToCloud(); renderBuildPage();
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
  const srcCs = state[srcCatId], dstCs = state[dstCatId];
  if (!srcCs || !dstCs) return;
  const name = srcCs.roster[fromIdx];
  if (name === undefined) return;
  srcCs.roster.splice(fromIdx, 1);
  if (toIdx < 0 || toIdx >= dstCs.roster.length) dstCs.roster.push(name);
  else dstCs.roster.splice(toIdx, 0, name);
  // Update registration's category in Firestore
  const parts = name.split(' / ').map(s => s.trim());
  const p1 = parts[0], p2 = parts[1] || '';
  const reg = registrations.find(r => r.p1 === p1 && (r.p2||'') === p2 && r.category === srcCatId);
  if (reg) {
    try {
      await updateDoc(doc(db, 'tournaments', tId, 'registrations', reg.id), { category: dstCatId });
      reg.category = dstCatId;
    } catch(e) { console.error('Could not update registration category', e); }
  }
  await pushToCloud();
  renderBuildPage();
  renderRegistrations();
}

function moveBuildItem(catId, idx, dir) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const cs = state[catId];
  if (!cs) return;
  const roster = cs.roster;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= roster.length) return;
  [roster[idx], roster[newIdx]] = [roster[newIdx], roster[idx]];
  pushToCloud();
  renderBuildPage();
}

function shuffleBuildRoster(catId) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const cs = state[catId];
  if (!cs) return;
  if (!cs.roster.length) {
    cs.roster = registrations.filter(r => r.status === 'approved' && r.category === catId)
      .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));
  }
  for (let i = cs.roster.length-1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [cs.roster[i], cs.roster[j]] = [cs.roster[j], cs.roster[i]];
  }
  pushToCloud();
  renderBuildPage();
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
  const p1    = document.getElementById('ap-p1').value.trim();
  const p2    = document.getElementById('ap-p2').value.trim();
  const catId = document.getElementById('ap-cat').value;
  if (!p1) return;
  const name = p2 ? `${p1} / ${p2}` : p1;
  if (!state[catId]) state[catId] = { roster:[], groups:[], sched:[], ko:[] };
  state[catId].roster.push(name);
  await addDoc(REGS_REF, { p1, p2, phone:'', category: catId, status:'approved', paid:false, createdAt: serverTimestamp() });
  await pushToCloud();
  await loadRegistrations();
  // Auto-save both players to the database
  if (p1) addPlayerToDB(p1, '');
  if (p2) addPlayerToDB(p2, '');
  closeAddPair();
  renderBuildPage();
}

// ===== COORDINATED MULTI-CATEGORY SCHEDULER (opt-in via meta.coordinated) =====
// Schedules ALL categories on ONE shared court grid: no cross-category court/time
// collisions, the finale (last category) finishes last, pools before KO, no pair
// plays >3 games in a row, compact blocks (low waiting). Runs on Build and re-runs
// on withdrawal so the board updates itself. Reads state[cat].groups; writes sched/ko.
function coordCfg(){
  const courts = Math.max(2, ...categories.map(c=>(c.cfg||DEF_CAT_CFG).courts||2));
  const c0 = (categories[0] && categories[0].cfg) || DEF_CAT_CFG;
  const slot = (c0.gameDur||20) + (c0.breakDur||0);
  const start = t2m(meta.startTime || c0.startTime || '17:00');
  return { COURTS:courts, SLOT:slot, START:start };
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
  const { COURTS, SLOT, START } = coordCfg();
  const cats = categories.filter(c => state[c.id] && (state[c.id].groups||[]).length);
  if(!cats.length) return;
  const finaleCat = cats[cats.length-1].id;
  const games=[], koStruct={};
  cats.forEach((cat,ci)=>{
    const groups=state[cat.id].groups; const poolIds=[];
    groups.forEach((grp,gi)=>rr(grp.teams).forEach(([a,b])=>{
      const id=`${cat.id}:P:${gi}:${a}#${b}`; poolIds.push(id);
      games.push({id,catId:cat.id,ci,kind:'pool',gi,gn:grp.name,a,b,teams:[`${cat.id}~${a}`,`${cat.id}~${b}`]});
    }));
    const cfg=cat.cfg||DEF_CAT_CFG; const adv=cfg.advPerGroup||0, ng=groups.length;
    if(adv>=1 && ng>=1){
      const seeds=[]; for(let rank=1;rank<=adv;rank++) for(let g=0;g<ng;g++) seeds.push(`${String.fromCharCode(65+g)}${rank}`);
      let bs=1; while(bs<seeds.length) bs*=2; while(seeds.length<bs) seeds.push('TBD');
      const rounds=[], first=[];
      for(let i=0;i<bs/2;i++) first.push({a:seeds[i],b:seeds[bs-1-i],seedA:seeds[i],seedB:seeds[bs-1-i],sa:'',sb:'',catId:cat.id});
      rounds.push(first);
      let m=first.length/2;
      while(m>=1){const rd=[]; for(let i=0;i<m;i++) rd.push({a:`W${i*2+1}`,b:`W${i*2+2}`,sa:'',sb:'',catId:cat.id}); rounds.push(rd); m=Math.floor(m/2);}
      koStruct[cat.id]=rounds;
      rounds.forEach((rd,ri)=>rd.forEach((g,gi)=>games.push({id:`${cat.id}:K${ri}:${gi}`,catId:cat.id,ci,kind:'ko',ri,gi,ref:g,poolIds,lastRound:ri===rounds.length-1})));
      const sfRound=rounds.length-2;
      if(sfRound>=0) games.push({id:`${cat.id}:3P`,catId:cat.id,ci,kind:'ko3p',sfRound,
        ref:{catId:cat.id,gi:-1,isThirdPlace:true,a:'Loser of SF1',b:'Loser of SF2',sa:'',sb:''}});
    }
  });
  const koRoundIds={};
  games.forEach(g=>{ if(g.kind==='ko')(koRoundIds[`${g.catId}:${g.ri}`]=koRoundIds[`${g.catId}:${g.ri}`]||[]).push(g.id); });
  const ready=(g,done)=>{
    if(g.kind==='pool') return true;
    if(g.kind==='ko3p') return (koRoundIds[`${g.catId}:${g.sfRound}`]||[]).every(id=>done.has(id));
    if(!g.poolIds.every(id=>done.has(id))) return false;
    if(g.ri===0) return true;
    return (koRoundIds[`${g.catId}:${g.ri-1}`]||[]).every(id=>done.has(id));
  };
  const isFinaleLast=g=>g.catId===finaleCat && ((g.kind==='ko'&&g.lastRound)||g.kind==='ko3p');
  const rankKind=g=>g.kind==='pool'?1:0, koOrder=g=>g.kind==='ko3p'?99:(g.kind==='ko'?g.ri:0);
  const rounds=[], done=new Set(); let rem=new Set(games.map(g=>g.id));
  const byId=Object.fromEntries(games.map(g=>[g.id,g])); const teamRounds={};
  const played=t=>teamRounds[t]||new Set();
  let guard=0;
  while(rem.size && guard++<500){
    const r=rounds.length;
    const cand=[...rem].map(id=>byId[id]).filter(g=>ready(g,done)&&!isFinaleLast(g));
    if(!cand.length){
      const fin=[...rem].map(id=>byId[id]).filter(g=>ready(g,done));
      if(fin.length){rounds.push(fin.map(g=>g.id)); fin.forEach(g=>{done.add(g.id);rem.delete(g.id);}); continue;}
      rounds.push([]); if(rounds.length>200) break; continue;
    }
    const lastPlayed=t=>{const s=played(t); return s.size?Math.max(...s):-99;};
    const phase=g=>g.catId===finaleCat?1:0;
    cand.sort((x,y)=>{
      if(phase(x)!==phase(y)) return phase(x)-phase(y);
      const kx=rankKind(x),ky=rankKind(y); if(kx!==ky) return kx-ky;
      if(kx===0) return (koOrder(x)-koOrder(y))||((x.gi||0)-(y.gi||0));
      const wx=Math.max(...x.teams.map(t=>r-lastPlayed(t))), wy=Math.max(...y.teams.map(t=>r-lastPlayed(t)));
      return wy-wx;
    });
    const chosen=[], usedTeams=new Set(), seenKO=new Set();
    for(const g of cand){
      if(chosen.length>=COURTS) break;
      if(g.kind==='pool'){
        if(g.teams.some(t=>usedTeams.has(t))) continue;
        if(g.teams.some(t=>played(t).has(r-1)&&played(t).has(r-2))) continue;
        g.teams.forEach(t=>usedTeams.add(t)); chosen.push(g);
      } else if(g.kind==='ko3p'){ chosen.push(g); }
      else {
        const sk=`${g.catId}:${g.ri}`; if(seenKO.has(sk)) continue; seenKO.add(sk);
        const stage=(koRoundIds[sk]||[]).map(id=>byId[id]).filter(x=>rem.has(x.id)&&ready(x,done)&&!isFinaleLast(x));
        if(chosen.length+stage.length>COURTS) continue;
        stage.forEach(x=>chosen.push(x));
      }
    }
    if(!chosen.length){rounds.push([]); continue;}
    rounds.push(chosen.map(g=>g.id));
    chosen.forEach(g=>{done.add(g.id);rem.delete(g.id); if(g.kind==='pool')g.teams.forEach(t=>{(teamRounds[t]=teamRounds[t]||new Set()).add(r);});});
  }
  cats.forEach(c=>{ state[c.id].sched=[]; state[c.id].ko=(koStruct[c.id]||[]).map(()=>[]); });
  rounds.forEach((ids,r)=>{ const time=m2t(START+r*SLOT);
    ids.forEach((id,ix)=>{ const g=byId[id], court=ix+1;
      if(g.kind==='pool') state[g.catId].sched.push({catId:g.catId,gi:g.gi,gn:g.gn,a:g.a,b:g.b,sa:'',sb:'',court,si:r,time});
      else if(g.kind==='ko3p') state[g.catId].sched.push({...g.ref,court,si:r,time});
      else state[g.catId].ko[g.ri][g.gi]={...g.ref,court,si:r,time};
    });
  });
  categories.forEach(c=>{ if(state[c.id]) updateKOForCat(c.id); });
}

async function buildTournament(catId) {
  if (!admin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  if (meta.coordinated) {
    buildCoordinatedGroups(); generateCoordinatedSchedule(); await pushToCloud();
    if (meta.phase === 'registration') { meta.phase = 'built'; await pushMetaOnly(); renderAll(); goPage('standings'); }
    else renderBuildPage();
    return;
  }
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cat || !cs) return;

  let roster = cs.roster.length ? cs.roster :
    registrations.filter(r => r.status === 'approved' && r.category === catId)
      .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));

  if (!roster.length) { alert('No approved pairs in this category.'); return; }

  const cfg = cat.cfg || DEF_CAT_CFG;
  const ng  = cfg.numGroups || 2;
  let groups;
  if (cfg.seeding === 'snake') {
    // Ranking tournament: pools by past ranking, serpentine (roster is ranked best-first).
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

  await pushToCloud();

  // First build → advance to 'built' phase so tournament tabs become visible
  if (meta.phase === 'registration') {
    meta.phase = 'built';
    await pushMetaOnly();
    renderAll();
    goPage('standings');
  } else {
    // Already in built phase → just refresh build page
    renderBuildPage();
  }
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
    firstRound.push({ a:aSeed, b:bSeed, seedA:aSeed, seedB:bSeed, sa:'', sb:'', catId });
  }
  firstRound.forEach((g, gi) => {
    g.court = (gi % nc) + 1;
    g.si    = rs + Math.floor(gi/nc);
    g.time  = addM(cfg.startTime||'08:00', g.si*slotDur);
  });
  rs += Math.ceil(firstRound.length / nc);
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
function isValidScore(sa, sb, catId, ptwOverride) {
  if (isNaN(sa)||isNaN(sb)||sa===''||sb==='') return false;
  if (sa < 0 || sb < 0) return false;
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  if (cfg.sets === 3) {
    const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
    return (hi===2 && lo>=0 && lo<=1);
  }
  const ptw = ptwOverride || cfg.pointsToWin || 21;
  if (sa===sb) return false;
  const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
  if (hi < ptw) return false;
  if (hi===ptw) return hi-lo>=2;
  return hi-lo===2;
}

function scoreError(sa, sb, catId, ptwOverride) {
  if (sa===''||sb==='') return null;
  const a=parseInt(sa), b=parseInt(sb);
  if (isNaN(a)||isNaN(b)) return null;
  if (a < 0 || b < 0) return 'Scores must be 0 or higher';
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  if (cfg.sets===3) {
    const hi=Math.max(a,b), lo=Math.min(a,b);
    if (hi>2||lo<0) return 'Sets won: 2:0 or 2:1';
    if (hi!==2) return 'Winner must have 2 sets';
    return null;
  }
  const ptw = ptwOverride || cfg.pointsToWin||21;
  const hi=Math.max(a,b), lo=Math.min(a,b);
  if (hi===lo) return `Scores can't be equal`;
  if (hi<ptw) return `Must reach ${ptw} · e.g. ${ptw}–${lo}`;
  if (hi===ptw && hi-lo<2) return `Need 2-point lead`;
  if (hi>ptw && hi-lo!==2) return `Above ${ptw}: exactly 2 apart`;
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
    if (!isValidScore(sa, sb, catId, getRuleForGame(catId, g, false).pts)) return;
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
  const played = cs.sched.filter(g=>g.gi===gi && isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false).pts)).length;
  const poolDone = played===totalGames && totalGames>0;
  const card = document.createElement('div');
  card.className = 'scard';
  card.dataset.ci = catIdx ?? 0;
  // Group colors: custom meta.groupColors overrides defaults
  const _grpDefaults = ['#E91E8C','#111111','#FFD600','#111111']; // B=black now
  const _grpColors  = _grpDefaults.map((d,i) => (meta.groupColors||[])[i] || d);
  const _grpOnColors= _grpColors.map(c => c.startsWith('#') ? onColor(c) : '#fff');
  const _grpColor   = _grpColors[gi % 4];
  const _grpOn      = _grpOnColors[gi % 4];
  card.style.setProperty('--cat-color',    _grpColor);
  card.style.setProperty('--cat-on-color', _grpOn);
  const rows = st.map((t,i) => {
    const isWinner = i<adv && poolDone;
    const diff = t.diff||0;
    const diffStr = diff>0?`+${diff}`:String(diff);
    const diffClass = diff>0?'diff-pos':diff<0?'diff-neg':'diff-zero';
    const ti = cs.groups[gi].teams.indexOf(t.name);
    const canEdit = superAdmin;
    const canDelete = superAdmin && (meta.phase === 'registration' || meta.phase === 'built');
    const adminCtrls = canEdit
      ? `<td><button class="gedit-btn" onclick="openEditTeam('${catId}',${gi},${ti})">✎</button>${
          canDelete?`<button class="team-del" onclick="deleteTeam('${catId}',${gi},${ti})">✕</button>`:''}</td>` : '';
    return `<tr class="${isWinner?'winner':''}">
      <td><span class="rnk">#${i+1}</span>${dnH(t.name)}</td>
      <td>${t.w}</td><td>${t.l}</td>
      <td class="${diffClass}">${diff!==0||t.w>0||t.l>0?diffStr:'—'}</td>
      <td><span class="pts-val">${t.pts}</span></td>
      ${adminCtrls}
    </tr>`;
  }).join('');
  const adminTh = superAdmin ? '<th></th>' : '';
  card.innerHTML = `<div class="scard-head"><span class="scard-name">GROUP ${escH(grp.name)}</span></div>
    <table class="stbl"><thead><tr><th>Team</th><th>W</th><th>L</th><th>+/−</th><th>Pts</th>${adminTh}</tr></thead>
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
  });
  if (!grid.children.length) {
    grid.innerHTML = `<div class="empty"><h3>No tournament data yet</h3><p>Build the tournament first.</p></div>`;
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
  document.getElementById('edit-modal-title').textContent = `Edit — Group ${state[catId].groups[gi].name}`;
  // Show category selector in tournament phase too
  const catRow = document.getElementById('edit-cat-row');
  const catSel = document.getElementById('edit-cat');
  if (catRow && catSel) {
    catSel.innerHTML = categories.map(c => `<option value="${escH(c.id)}"${c.id===catId?' selected':''}>${escH(c.name)}</option>`).join('');
    catRow.classList.remove('h');
  }
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}
function closeEdit() {
  document.getElementById('edit-modal').classList.add('h');
  editTarget = null;
}
function saveEdit() {
  if (!admin || !editTarget) return;
  const p1 = document.getElementById('edit-p1').value.trim();
  const p2 = document.getElementById('edit-p2').value.trim();
  const name = p2?`${p1} / ${p2}`:p1;
  if (!name) return;

  // Build page roster edit
  if (editTarget.buildIdx !== undefined) {
    const { catId, buildIdx, oldName } = editTarget;
    const newCatId = document.getElementById('edit-cat')?.value || catId;
    if (newCatId !== catId) {
      // Cross-category move via edit
      state[catId].roster.splice(buildIdx, 1);
      if (!state[newCatId]) state[newCatId] = { roster:[], groups:[], sched:[], ko:[] };
      state[newCatId].roster.push(name);
      const oldParts = (oldName||'').split(' / ').map(s=>s.trim());
      const reg = registrations.find(r =>
        r.p1===oldParts[0] && (r.p2||'')===(oldParts[1]||'') && r.category===catId);
      if (reg) {
        updateDoc(doc(db,'tournaments',tId,'registrations',reg.id), {category:newCatId, p1, p2});
        reg.category = newCatId; reg.p1 = p1; reg.p2 = p2;
      }
    } else {
      state[catId].roster[buildIdx] = name;
      const oldParts = (oldName||'').split(' / ').map(s=>s.trim());
      const reg = registrations.find(r =>
        r.p1===oldParts[0] && (r.p2||'')===(oldParts[1]||'') && r.category===catId);
      if (reg) {
        updateDoc(doc(db,'tournaments',tId,'registrations',reg.id), {p1, p2});
        reg.p1 = p1; reg.p2 = p2;
      }
    }
    closeEdit(); pushToCloud(); renderBuildPage(); renderRegistrations();
    return;
  }

  // Standings group team edit — master only
  if (!superAdmin) return;
  const {catId,gi,ti} = editTarget;
  const old = state[catId].groups[gi].teams[ti];
  state[catId].groups[gi].teams[ti] = name;
  state[catId].sched.forEach(g => { if(g.a===old)g.a=name; if(g.b===old)g.b=name; });
  state[catId].ko.forEach(r => r.forEach(g => { if(g.a===old)g.a=name; if(g.b===old)g.b=name; }));
  // Also update flat roster
  const rIdx = state[catId].roster?.indexOf(old);
  if (rIdx >= 0) state[catId].roster[rIdx] = name;
  closeEdit(); pushToCloud(); renderStandings(); renderScheduleContent(); renderBracket();
}
function deleteTeam(catId, gi, ti) {
  if (!superAdmin || (meta.phase !== 'registration' && meta.phase !== 'built')) return;
  const cs  = state[catId];
  const grp = cs.groups[gi];
  if (grp.teams.length<=1) { alert('Group needs at least 1 team'); return; }
  if (!confirm(`Remove "${grp.teams[ti]}" from group ${grp.name}?`)) return;
  grp.teams.splice(ti,1);
  // Coordinated mode: re-run the whole shared-grid scheduler so the board updates itself.
  if (meta.coordinated) { generateCoordinatedSchedule(); pushToCloud(); renderAll(); return; }
  // Withdrawal before start: re-optimize the pool schedule (no idle court) — keep the bracket
  if (cs.sched?.some(g => g.gi >= 0)) {
    const third = cs.sched.find(g => g.isThirdPlace);
    cs.sched = genPoolSched(catId);
    if (third) cs.sched.push(third);
    assignSlotTimes(catId);
  }
  pushToCloud(); renderAll();
}

// ============ SCORES ============
function setGS(catId, idx, k, v) {
  if (!admin || meta.phase !== 'tournament') return;
  state[catId].sched[idx][k] = v;
  const g = state[catId].sched[idx];
  const rule = getRuleForGame(catId, g, false);
  const err = scoreError(g.sa, g.sb, catId, rule.pts);
  const errEl = document.getElementById(`gerr-${catId}-${idx}`);
  if (errEl) { errEl.textContent=err||''; errEl.style.display=err?'block':'none'; }
  if (!err) { updateKOForCat(catId); pushToCloud(); renderStandings(); }
}
function setKS(catId, ri, gi, k, v) {
  if (!admin || meta.phase !== 'tournament') return;
  state[catId].ko[ri][gi][k] = v;
  const g = state[catId].ko[ri][gi];
  g.ri = ri;
  const rule = getRuleForGame(catId, g, true);
  const err = scoreError(g.sa, g.sb, catId, rule.pts);
  const errEl = document.getElementById(`kerr-${catId}-${ri}-${gi}`);
  if (errEl) { errEl.textContent=err||''; errEl.style.display=err?'block':'none'; }
  if (!err) { updateKOForCat(catId); pushToCloud(); }
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
  const done = cs.sched.filter(g=>g.gi===gi&&isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false).pts)).length;
  if (done!==totalGames) return { label:seed, known:false };
  const st = getStandings(catId, gi);
  if (!st[rank-1]) return { label:seed, known:false };
  return { label:st[rank-1].name, known:true };
}

function getKOLoser(game, catId) {
  if (!game || game.isBye) return null;
  const sa=parseInt(game.sa), sb=parseInt(game.sb);
  if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true).pts)) return sa>sb ? game.b : game.a;
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
  if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true).pts)) return sa>sb?game.a:game.b;
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
      if (g.isThirdPlace) return;
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
    if (thirdGame && sfRound) {
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

// ============ ONE-TIME BRACKET FIX ============
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
    donePool  += poolG.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),cat.id,getRuleForGame(cat.id,g,false).pts)).length;
    totalKO   += cs.ko.reduce((s,r)=>s+r.filter(g=>!g.isBye).length, 0) + thirdG.length;
    const last = cs.ko.length ? cs.ko[cs.ko.length-1][0] : cs.sched[cs.sched.length-1];
    if (last?.time && t2m(last.time)>t2m(lastTime)) { lastTime=last.time; lastDur=cat.cfg?.gameDur||30; }
  });
  if (!totalPool) { el.innerHTML=''; return; }
  el.innerHTML = `
    <div class="sc"><div class="sl">Pool Games</div><div class="sv">${donePool}/${totalPool}</div></div>
    <div class="sc"><div class="sl">KO Games</div><div class="sv">${totalKO}</div></div>
    <div class="sc"><div class="sl">Est. End</div><div class="sv a">${addM(lastTime,lastDur)}</div></div>`;
}

function buildGameRow(catId, g, idx, isKO) {
  const rule = getRuleForGame(catId, g, isKO);
  const done = isValidScore(parseInt(g.sa), parseInt(g.sb), catId, rule.pts);
  // Color pill by group index for pool; by court→group for KO (dynamic group colors)
  const pc = `gi${isKO ? (g.court-1)%4 : (g.gi ?? 0) % 4}`;
  const wrap = document.createElement('div');
  const row  = document.createElement('div');
  const koLbl = isKO ? koGameLabel(catId, g.ri, g.gi) : '';
  row.className = 'gc'+(done?' done':'')+(isKO?' ko-game':'');
  const scoreCell = (admin && meta.phase === 'tournament')
    ? `<input class="si" type="number" min="0" inputmode="numeric" placeholder="—" value="${g.sa}"
         oninput="${isKO?`setKS('${catId}',${g.ri},${g.gi},'sa',this.value)`:`setGS('${catId}',${idx},'sa',this.value)`}"/>
       <span class="ssep">:</span>
       <input class="si" type="number" min="0" inputmode="numeric" placeholder="—" value="${g.sb}"
         oninput="${isKO?`setKS('${catId}',${g.ri},${g.gi},'sb',this.value)`:`setGS('${catId}',${idx},'sb',this.value)`}"/>`
    : `<span class="ssep">${done?`${g.sa} : ${g.sb}`:'— : —'}</span>`;

  row.innerHTML = `
    <span class="pill ${pc}">C${g.court}</span>
    ${koLbl?`<span class="ko-lbl">${koLbl}</span>`:''}
    <span class="gt">${dnH(g.a)}${!isKO&&g.gn?`<span class="gtag">${escH(g.gn)}</span>`:''}</span>
    <span class="gvs">vs</span>
    <span class="gt r">${dnH(g.b)}</span>
    <span class="sw">${scoreCell}</span>`;
  const errId = isKO ? `kerr-${catId}-${g.ri}-${g.gi}` : `gerr-${catId}-${idx}`;
  const errD  = document.createElement('div');
  errD.id = errId; errD.className = 'score-err'; errD.style.display = 'none';
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
    el.innerHTML = `<div class="empty"><h3>No schedule yet</h3><p>Build the tournament first.</p></div>`;
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
      .forEach(g=>allGames.push({...g,_catId:cat.id,_idx:-1,_isKO:true,_rn:getKORoundName(cat.id,g.ri)}));
  });
  if (!allGames.length) { el.innerHTML=`<div class="empty"><h3>No games</h3></div>`; return; }

  const inp = document.getElementById('sched-search');
  const q   = (inp?.value||'').trim().toLowerCase();
  const filtered = q
    ? allGames.filter(g => g.a.toLowerCase().includes(q)||g.b.toLowerCase().includes(q))
    : allGames;
  if (q && !filtered.length) {
    el.innerHTML=`<div class="empty"><h3>No match for "${escH(q)}"</h3></div>`; return;
  }

  const byTime = {};
  filtered.forEach(g => { const k=g.time||'00:00'; if(!byTime[k])byTime[k]=[]; byTime[k].push(g); });
  el.innerHTML = '';
  Object.keys(byTime).sort((a,b)=>t2m(a)-t2m(b)).forEach(time => {
    const games = byTime[time];
    const block = document.createElement('div');
    block.className='tblock';
    // Build sub-groups: key = catId + type
    const subGroups = new Map();
    games.forEach(g => {
      const isThirdPlace = !g._isKO && g.gi === -1;
      let key, label;
      const catName = categories.find(c=>c.id===g._catId)?.name || '';
      if (g._isKO) { key = `ko-${g._catId}-${g._rn}`; label = catName ? `${catName} — ${g._rn}` : g._rn; }
      else if (isThirdPlace) { key = `3p-${g._catId}`; label = catName ? `${catName} — 3/4` : '3/4'; }
      else { key = `pool-${g._catId}`; label = catName ? `${catName} — Pools` : 'Pools'; }
      if (!subGroups.has(key)) subGroups.set(key, {label, games:[]});
      subGroups.get(key).games.push(g);
    });
    const needSubHeaders = subGroups.size > 1 || [...subGroups.values()].some(s=>s.label);
    block.innerHTML=`<div class="thdr"><span class="tlbl">${time}</span><div class="tline"></div></div>`;
    subGroups.forEach(({label, games: sg}) => {
      if (needSubHeaders && label) {
        const sh = document.createElement('div');
        sh.className = 'tsub-hdr';
        const firstG = sg[0];
        const r = getRuleForGame(firstG._catId, firstG, firstG._isKO);
        const ruleStr = (meta.sport === 'volleyball') ? '' : (r.change ? ` (to ${r.pts} switch ${r.change})` : ` (to ${r.pts})`);
        sh.textContent = label + ruleStr;
        block.appendChild(sh);
      }
      sg.forEach(g => block.appendChild(buildGameRow(g._catId, g, g._idx, g._isKO)));
    });
    el.appendChild(block);
  });
}

function filterSchedule() { renderScheduleContent(); }

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
  el.innerHTML = `<button class="cf-btn ${activeCourt==='all'?'on':''}" onclick="setCourt('all')">All</button>`
    + [...courts].sort((a,b)=>a-b).map(c =>
        `<button class="cf-btn ${activeCourt===c?'on':''}" onclick="setCourt(${c})">Court ${c}</button>`).join('');
}

function setCourt(c) { activeCourt=c; renderCourtFilter(); renderScheduleContent(); }

// ============ BRACKET ============
function renderBracketForCat(catId, container) {
  const cs  = state[catId];
  const cat = categories.find(c=>c.id===catId);
  if (!cs||!cat) return;
  const cfg = cat.cfg||DEF_CAT_CFG;
  const adv = cfg.advPerGroup||0;
  const ng  = cs.groups.length;

  updateKOForCat(catId);

  const poolGames = cs.sched.filter(g=>g.gi>=0);   // exclude the 3rd-place game (gi=-1)
  const done  = poolGames.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false).pts)).length;
  const total = poolGames.length;
  const info  = document.createElement('div');
  info.className='binfo';
  info.innerHTML = !total ? 'No pool stage scheduled yet.'
    : `Pool: <span>${done}/${total} played</span> — bracket updates live`;
  container.appendChild(info);
  if (!cs.ko.length) return;

  const koSeeds=[];
  for (let rank=1; rank<=adv; rank++)
    for (let g=0; g<ng; g++)
      koSeeds.push(`${String.fromCharCode(65+g)}${rank}`);
  const nKO=koSeeds.length;
  const seedPairs=[];
  for (let i=0; i<Math.floor(nKO/2); i++) seedPairs.push([koSeeds[i],koSeeds[nKO-1-i]]);

  const scroll=document.createElement('div'); scroll.className='bscroll';
  const tree=document.createElement('div'); tree.className='btree';
  scroll.appendChild(tree);
  const HG=90, GAP=12;

  // Helper: build a single match box element
  const mkBox = (g, gi, ri) => {
    if (g.isBye) {
      const seed=g.seedA||g.a||'TBD';
      const res=resolvePoolSeed(catId,seed);
      const label=dnH(res.known?res.label:seed);
      const box=document.createElement('div'); box.className='bmatch-box bmatch-box--bye';
      box.innerHTML=`<div class="bmatch bmatch-bye">
        <div class="bteam ${res.known?'win':'tbd'}">
          <span class="bname">${label}</span><span class="bye-badge">Direct ↗</span>
        </div>
      </div>`;
      return box;
    }
    const sa=parseInt(g.sa), sb=parseInt(g.sb);
    const hs=isValidScore(sa,sb,catId,getRuleForGame(catId,g,true).pts);
    const wa=hs&&sa>sb, wb=hs&&sb>sa;
    let labelA=g.a||'TBD', labelB=g.b||'TBD', codeA='', codeB='', knownA=false, knownB=false;
    if (ri===0) {
      const sAk=g.seedA||seedPairs[gi]?.[0]||'TBD', sBk=g.seedB||seedPairs[gi]?.[1]||'TBD';
      const sA=resolvePoolSeed(catId,sAk), sB=resolvePoolSeed(catId,sBk);
      labelA=dnH(sA.known?sA.label:sAk); labelB=dnH(sB.known?sB.label:sBk);
      codeA=sA.known?sAk:''; codeB=sB.known?sBk:'';
      knownA=sA.known; knownB=sB.known;
    } else {
      const isSeed = s => !s || s.startsWith('Winner') || /^[A-Z]\d+(\/[A-Z]\d+)?$/.test(s);
      knownA=!isSeed(g.a);
      knownB=!isSeed(g.b);
      if (g.directSeedA&&knownA) codeA=g.directSeedA;
      if (g.directSeedB&&knownB) codeB=g.directSeedB;
      labelA=dnH(labelA); labelB=dnH(labelB);
    }
    const box=document.createElement('div'); box.className='bmatch-box';
    const glbl=koGameLabel(catId,ri,gi);
    box.innerHTML=(glbl?`<div class="bm-label">${glbl}</div>`:'')+`<div class="bmatch">
      <div class="bteam ${wa?'win':''} ${knownA?'':'tbd'}${g.directSeedA?' bdirect':''}">
        <span class="bname">${labelA}</span>${codeA?`<span class="bsc seed-tag">${codeA}</span>`:''}${hs?`<span class="bsc">${g.sa}</span>`:''}
      </div>
      <div class="bteam ${wb?'win':''} ${knownB?'':'tbd'}${g.directSeedB?' bdirect':''}">
        <span class="bname">${labelB}</span>${codeB?`<span class="bsc seed-tag">${codeB}</span>`:''}${hs?`<span class="bsc">${g.sb}</span>`:''}
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
    const col=document.createElement('div'); col.className='bround';
    col.innerHTML=`<div class="brnd-title">${getKORoundName(catId,0)} <span class="brnd-arrow">→</span> ${getKORoundName(catId,1)}</div>`;
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
    const col=document.createElement('div'); col.className='bround';
    col.innerHTML=`<div class="brnd-title">${getKORoundName(catId,ri)}</div>`;
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
      const hs3=isValidScore(sa3,sb3,catId,getRuleForGame(catId,thirdGame,false).pts);
      const wa3=hs3&&sa3>sb3, wb3=hs3&&sb3>sa3;
      const isSeed3=s=>!s||s.startsWith('Loser')||/^[A-Z]\d+(\/[A-Z]\d+)?$/.test(s);
      const lA3=dnH(thirdGame.a||'TBD'), lB3=dnH(thirdGame.b||'TBD');
      const knownA3=!isSeed3(thirdGame.a), knownB3=!isSeed3(thirdGame.b);
      const div3=document.createElement('div');
      div3.style.cssText='border-top:1px solid rgba(255,255,255,0.15);margin-top:16px;padding-top:10px;';
      const box3=document.createElement('div'); box3.className='bmatch-box';
      box3.innerHTML=`<div class="bm-label">3rd Place</div><div class="bmatch">
        <div class="bteam ${wa3?'win':''} ${knownA3?'':'tbd'}"><span class="bname">${lA3}</span>${hs3?`<span class="bsc">${thirdGame.sa}</span>`:''}</div>
        <div class="bteam ${wb3?'win':''} ${knownB3?'':'tbd'}"><span class="bname">${lB3}</span>${hs3?`<span class="bsc">${thirdGame.sb}</span>`:''}</div>
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
    if (isValidScore(fsa,fsb,catId,getRuleForGame(catId,fin,true).pts)) {
      const w=fsa>fsb?fin.a:fin.b;
      const champEl=document.createElement('div');
      champEl.innerHTML=`<div class="champ-wrap"><div class="ci">CHAMPION</div><div class="champ-name">${dnH(w)}</div></div>`;
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
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.className = 'bsvg';
    Object.assign(svg.style, {
      position:'absolute', top:'0', left:'0', pointerEvents:'none',
      width: scroll.scrollWidth+'px', height: scroll.scrollHeight+'px',
      overflow:'visible', zIndex:'0'
    });
    scroll.style.position = 'relative';

    const rounds = [...scroll.querySelectorAll('.bround')];
    const C = 'rgba(255,255,255,0.25)';

    const mk = (x1,y1,x2,y2) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg','line');
      el.setAttribute('x1',Math.round(x1)); el.setAttribute('y1',Math.round(y1));
      el.setAttribute('x2',Math.round(x2)); el.setAttribute('y2',Math.round(y2));
      el.setAttribute('stroke',C); el.setAttribute('stroke-width','2');
      el.setAttribute('stroke-linecap','round');
      svg.appendChild(el);
    };

    const getPos = wrap => {
      const b = wrap.querySelector('.bmatch-box');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        rx: r.left - sR.left + SL + r.width,
        lx: r.left - sR.left + SL,
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
          const vx = (Math.max(s0.rx, s1?.rx ?? s0.rx) + dst.lx) / 2;
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

function renderBracket() {
  const container=document.getElementById('bracket-container');
  if (!container) return;
  container.innerHTML='';
  const cats=activeCat?categories.filter(c=>c.id===activeCat):categories;
  cats.forEach(cat => {
    if (cats.length>1) {
      const hdr=document.createElement('div');
      hdr.className='cat-section-header'; hdr.textContent=cat.name;
      container.appendChild(hdr);
    }
    renderBracketForCat(cat.id, container);
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
    <button class="cat-btn ${!activeCat?'on':''}" onclick="setCat(null)">All</button>
    ${categories.map(c=>`<button class="cat-btn ${activeCat===c.id?'on':''}" onclick="setCat('${escH(c.id)}')">${escH(c.name)}</button>`).join('')}
  </div>`;
}

// ============ SETTINGS ============
function renderSettings() {
  const container = document.getElementById('settings-container');
  if (!container || !superAdmin) return;
  container.innerHTML = '';

  // ── DESIGN ──────────────────────────────────────────────────────
  const pc = meta.primaryColor   || '#6B21A8';
  const sc = meta.secondaryColor || pc;
  const dsec = document.createElement('div');
  dsec.className = 'sett-section';
  dsec.innerHTML = `
    <div class="sett-section-title">Design</div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">Tournament Name</span></div>
      <div class="sett-ctrl">
        <input class="text-inp" style="width:220px" value="${escH(meta.name)}"
          onchange="updateMeta('name',this.value)" placeholder="Tournament name"/>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label">
        <span class="sett-name">Primary Color</span>
        <span class="sett-desc">Main accent — headers, buttons</span>
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
        <span class="sett-name">Secondary Color</span>
        <span class="sett-desc">Gradient & accent buttons</span>
      </div>
      <div class="sett-ctrl color-pick-row">
        <input type="color" class="color-inp" id="cp-secondary" value="${sc}"
          oninput="document.getElementById('ct-secondary').value=this.value;updateMeta('secondaryColor',this.value)"/>
        <input class="text-inp text-mono" id="ct-secondary" style="width:100px" value="${sc}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('cp-secondary').value=this.value;updateMeta('secondaryColor',this.value)}"/>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">Preview</span></div>
      <div class="theme-preview" style="background:linear-gradient(135deg,${pc},${sc})">
        <span style="color:${onColor(pc)};font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;letter-spacing:1px">Aa</span>
      </div>
    </div>
    <div class="sett-row" style="border-bottom:none;padding-bottom:0">
      <div class="sett-label">
        <span class="sett-name">Background Color</span>
        <span class="sett-desc">Site background override</span>
      </div>
      <div class="sett-ctrl color-pick-row">
        <input type="color" class="color-inp" id="cp-bg" value="${meta.bgColor||'#ffffff'}"
          oninput="document.getElementById('ct-bg').value=this.value;updateBgColor(this.value)"/>
        <input class="text-inp text-mono" id="ct-bg" style="width:100px" value="${meta.bgColor||'#ffffff'}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('cp-bg').value=this.value;updateBgColor(this.value)}"/>
        <button class="add-cat-btn" style="font-size:11px;padding:5px 10px" onclick="updateBgColor('')">Reset</button>
      </div>
    </div>`;
  container.appendChild(dsec);

  // ── LOGO ────────────────────────────────────────────────────────
  const lsec = document.createElement('div');
  lsec.className = 'sett-section';
  lsec.innerHTML = `
    <div class="sett-section-title">Logo</div>
    <div class="sett-row" style="border-bottom:none">
      <div class="sett-label">
        <span class="sett-name">Logo URL</span>
        <span class="sett-desc">Tournament logo image</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:10px">
        <input class="text-inp" style="width:260px" value="${escH(meta.logoUrl)}"
          onchange="updateMeta('logoUrl',this.value)" placeholder="https://…"/>
        ${meta.logoUrl ? `<img src="${escH(meta.logoUrl)}" class="logo-prev-img" alt="" onerror="this.style.display='none'"/>` : ''}
      </div>
    </div>`;
  container.appendChild(lsec);

  // ── GROUP COLORS ─────────────────────────────────────────────────
  const grpNames = ['A','B','C','D'];
  const grpDefaults = ['#E91E8C','#111111','#FFD600','#111111'];
  const gcsec = document.createElement('div');
  gcsec.className = 'sett-section';
  gcsec.innerHTML = `<div class="sett-section-title">Group Colors</div>` +
    grpNames.map((n,i) => {
      const cur = (meta.groupColors||[])[i] || grpDefaults[i];
      return `<div class="sett-row${i===grpNames.length-1?' last-row':''}">
        <div class="sett-label"><span class="sett-name">Group ${n}</span></div>
        <div class="sett-ctrl color-pick-row">
          <input type="color" class="color-inp" id="gcp-${i}" value="${cur}"
            oninput="document.getElementById('gct-${i}').value=this.value;updateGroupColor(${i},this.value)"/>
          <input class="text-inp text-mono" id="gct-${i}" style="width:100px" value="${cur}"
            onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('gcp-${i}').value=this.value;updateGroupColor(${i},this.value)}"/>
          <button class="add-cat-btn" style="font-size:11px;padding:5px 10px"
            onclick="updateGroupColor(${i},'${grpDefaults[i]}');renderSettings()">Reset</button>
        </div>
      </div>`;
    }).join('');
  container.appendChild(gcsec);

  // ── SPONSORS ────────────────────────────────────────────────────
  const ssec = document.createElement('div');
  ssec.className = 'sett-section';
  const logos = Array.isArray(meta.sponsorLogos) ? meta.sponsorLogos : [];
  ssec.innerHTML = `
    <div class="sett-section-title">Sponsors</div>
    <div id="sponsor-edit-list">${logos.length
      ? logos.map((l,i) => `
        <div class="sprow">
          <div class="sp-thumb">${l.url
            ? `<img src="${escH(l.url)}" alt="" onerror="this.style.display='none'" style="max-width:52px;max-height:32px;object-fit:contain"/>`
            : `<span style="color:var(--text3);font-size:20px;line-height:1">+</span>`}</div>
          <input class="text-inp" style="flex:1;min-width:0" value="${escH(l.url)}"
            placeholder="Image URL…" onchange="updateSponsorLogo(${i},'url',this.value)"/>
          <input class="text-inp" style="width:100px;flex-shrink:0" value="${escH(l.alt)}"
            placeholder="Name…" onchange="updateSponsorLogo(${i},'alt',this.value)"/>
          <button class="team-del" onclick="removeSponsorLogo(${i})" title="Remove">✕</button>
        </div>`).join('')
      : `<p class="sett-empty-note">No sponsors yet — add one below.</p>`}
    </div>
    <div class="sett-add-row">
      <button class="add-cat-btn" onclick="addSponsorLogo()">+ Add Sponsor</button>
    </div>`;
  container.appendChild(ssec);

  // ── PLAYERS DATABASE ────────────────────────────────────────────
  renderPlayerDBSection(container);

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
              <span style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;flex-shrink:0">Group</span>
              <input class="text-inp" style="width:54px;font-weight:800;text-align:center;font-size:15px;padding:5px 4px"
                value="${escH(grp.name)}" onchange="renameGroup('${cat.id}',${gi},this.value)"/>
              <span style="font-size:11px;color:var(--text3);margin-left:4px">${grp.teams.length} teams</span>
            </div>
            <div class="grp-teams-list">
              ${grp.teams.map((team, ti) => `
                <div class="grp-team-item">
                  <span class="grp-team-name">${escH(team)}</span>
                  ${cs.groups.length > 1 ? `<select class="move-sel"
                    onchange="moveTeam('${cat.id}',${gi},${ti},parseInt(this.value));this.selectedIndex=0">
                    <option value="" disabled selected>Move to…</option>
                    ${cs.groups.map((tg,gj) => gj===gi ? '' : `<option value="${gj}">→ ${escH(tg.name)}</option>`).join('')}
                  </select>` : ''}
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>`;
    }).join('');
    gsec.innerHTML = `<div class="sett-section-title">Groups</div>${gHtml}`;
    container.appendChild(gsec);
  }

  if (meta.phase === 'tournament') return;

  // ── SPORT ───────────────────────────────────────────────────────
  const sportSection = document.createElement('div');
  sportSection.className = 'sett-section';
  sportSection.innerHTML = `<div class="sett-section-title">Sport</div>
    <div class="sett-row" style="border-bottom:none;align-items:flex-start">
      <div class="sett-label"><span class="sett-name">Sport</span>
        <span class="sett-desc">Volleyball hides the per-stage "(to 21 switch 7)" note — scoring is always to 21. Footvolley shows custom per-stage points.</span></div>
      <div class="sett-ctrl">
        <select class="text-inp" onchange="updateMeta('sport',this.value)">
          <option value="footvolley" ${meta.sport!=='volleyball'?'selected':''}>Footvolley / custom</option>
          <option value="volleyball" ${meta.sport==='volleyball'?'selected':''}>Volleyball (עד 21)</option>
        </select>
      </div>
    </div>`;
  container.appendChild(sportSection);

  // ── REGISTRATION ────────────────────────────────────────────────
  const regSection = document.createElement('div');
  regSection.className = 'sett-section';
  regSection.innerHTML = `<div class="sett-section-title">Registration</div>
    <div class="toggle-row">
      <span class="toggle-label">Registration Open</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.regOpen?'checked':''} onchange="updateMeta('regOpen',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row" style="border-bottom:none">
      <span class="toggle-label">Show Participant List (public)</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.showRegistered?'checked':''} onchange="updateMeta('showRegistered',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="sett-row" style="align-items:flex-start;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">Registration Note</span>
        <span class="sett-desc">Shown below the registration form.</span>
      </div>
      <div class="sett-ctrl">
        <textarea class="text-inp" style="width:240px;height:76px;resize:vertical;line-height:1.5"
          onchange="updateMeta('regNote',this.value)"
          placeholder="e.g. Payment deadline is Friday…">${escH(meta.regNote)}</textarea>
      </div>
    </div>
    <div class="sett-row" style="align-items:flex-start;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">Payment Links</span>
        <span class="sett-desc">Shown in the registration form.</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:8px">
        <div style="display:flex;gap:6px;align-items:center">
          <input class="text-inp" value="${escH(meta.paymentLinkLabel)}" style="width:100px" placeholder="Label…"
            onchange="updateMeta('paymentLinkLabel',this.value)"/>
          <input class="text-inp" value="${escH(meta.paymentLink)}" style="width:190px" placeholder="https://…"
            onchange="updateMeta('paymentLink',this.value)"/>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="text-inp" value="${escH(meta.paymentLink2Label)}" style="width:100px" placeholder="Label…"
            onchange="updateMeta('paymentLink2Label',this.value)"/>
          <input class="text-inp" value="${escH(meta.paymentLink2)}" style="width:190px" placeholder="https://… (optional)"
            onchange="updateMeta('paymentLink2',this.value)"/>
        </div>
      </div>
    </div>`;
  container.appendChild(regSection);

  // ── CATEGORIES ──────────────────────────────────────────────────
  const catSection = document.createElement('div');
  catSection.className = 'sett-section';
  catSection.innerHTML = `<div class="sett-section-title">Categories</div>
    <div id="cat-list">${categories.map((cat,ci)=>renderCatItem(cat,ci)).join('')}</div>
    <div class="sett-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:14px;border-bottom:none;padding-bottom:0">
      <div class="sett-label">
        <span class="sett-name">Add Category</span>
        <span class="sett-desc">Create a new category for this tournament</span>
      </div>
      <button class="add-cat-btn" onclick="addCategory()">+ Add</button>
    </div>`;
  container.appendChild(catSection);

  // ── START TOURNAMENT ────────────────────────────────────────────
  const startSection = document.createElement('div');
  startSection.className = 'sett-section';
  startSection.style.textAlign = 'center';
  startSection.innerHTML = `
    <div class="sett-section-title">Start Tournament</div>
    <p style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.55">
      When all pairs are ready, start the tournament.<br>
      Pairs and settings cannot be changed after this.
    </p>
    <button class="gen-btn" onclick="openStartModal()">▶ Start Tournament</button>`;
  container.appendChild(startSection);
}

// ── Dynamic group color CSS ──────────────────────────────────────
const GRP_DEFAULTS = ['#E91E8C','#111111','#FFD600','#111111'];
function applyGroupColors() {
  const colors = GRP_DEFAULTS.map((d,i) => (meta.groupColors||[])[i] || d);
  const style = document.getElementById('grp-color-style') || (() => {
    const s=document.createElement('style'); s.id='grp-color-style'; document.head.appendChild(s); return s;
  })();
  style.textContent = colors.map((c,i) => {
    const oc = onColor(c);
    return `.gi${i}{background:${c};color:${oc}}`;
  }).join('');
}

// ── Site colors ──────────────────────────────────────────────────
function updateBgColor(color) {
  meta.bgColor = color;
  document.body.style.backgroundColor = color;
  pushMetaOnly();
}
function updateGroupColor(gi, color) {
  // Ensure full 4-element array (avoids sparse array issues in Firestore)
  const cur = [...GRP_DEFAULTS.map((d,i) => (meta.groupColors||[])[i] || d)];
  cur[gi] = color;
  meta.groupColors = cur;
  applyGroupColors();
  pushMetaOnly();
  renderStandings();
  renderBuildPage();
  renderScheduleContent();
}

// ── Category color ───────────────────────────────────────────────
function updateCatColor(ci, color) {
  if (!categories[ci]) return;
  categories[ci].color = color;
  pushToCloud();
  renderStandings();
  renderBuildPage();
}

// ── Group management ─────────────────────────────────────────────
function renameGroup(catId, gi, name) {
  const cs = state[catId];
  if (!cs || !cs.groups[gi]) return;
  cs.groups[gi].name = name;
  cs.sched.forEach(g => { if (g.gi === gi) g.gn = name; });
  pushToCloud();
  renderStandings();
  renderScheduleContent();
}

function moveTeam(catId, fromGi, teamIdx, toGi) {
  if (fromGi === toGi) return;
  const cs = state[catId];
  if (!cs || !cs.groups[fromGi] || !cs.groups[toGi]) return;
  const team = cs.groups[fromGi].teams[teamIdx];
  if (!team) return;
  cs.groups[fromGi].teams.splice(teamIdx, 1);
  cs.groups[toGi].teams.push(team);
  cs.sched.forEach(g => {
    if ((g.a === team || g.b === team) && g.gi === fromGi) g.gi = toGi;
  });
  pushToCloud();
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
  pushMetaOnly();
}
function removeSponsorLogo(i) {
  if (!Array.isArray(meta.sponsorLogos)) return;
  meta.sponsorLogos.splice(i, 1);
  renderSponsorBar();
  renderSettings();
  pushMetaOnly();
}
function addSponsorLogo() {
  if (!Array.isArray(meta.sponsorLogos)) meta.sponsorLogos = [];
  meta.sponsorLogos.push({ url: '', alt: '' });
  renderSettings();
}

function renderCatItem(cat, ci) {
  const cfg=cat.cfg||DEF_CAT_CFG;
  const defaultColors=['','#D97706','#0891B2','#EA580C'];
  const catColor = cat.color || defaultColors[ci] || '#6B21A8';
  return `<div class="cat-item">
    <div class="cat-item-head">
      <input class="text-inp" style="width:150px;font-weight:600" value="${escH(cat.name)}" onchange="updateCatName(${ci},this.value)"/>
      <div class="color-pick-row" style="margin-left:auto;margin-right:8px">
        <input type="color" class="color-inp" id="ccp-${ci}" style="width:36px;height:32px" value="${catColor}"
          oninput="document.getElementById('cct-${ci}').value=this.value;updateCatColor(${ci},this.value)"/>
        <input class="text-inp text-mono" id="cct-${ci}" style="width:84px;padding:5px 8px;font-size:12px" value="${catColor}"
          onchange="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)){document.getElementById('ccp-${ci}').value=this.value;updateCatColor(${ci},this.value)}"/>
      </div>
      <button class="team-del" onclick="deleteCategory(${ci})" title="Delete">✕</button>
    </div>
    <div class="cat-settings-grid">
      ${catNumField('Courts', ci, 'courts', cfg.courts, 1, 8)}
      ${catNumField('Groups', ci, 'numGroups', cfg.numGroups, 2, 16)}
      ${catNumField('Adv/Group', ci, 'advPerGroup', cfg.advPerGroup, 1, 8)}
      ${catNumField('Game min', ci, 'gameDur', cfg.gameDur, 5, 120)}
      ${catNumField('Break min', ci, 'breakDur', cfg.breakDur, 0, 60)}
      <div class="cat-sett-field">
        <span class="cat-sett-label">Sets</span>
        <div class="cat-sett-ctrl">
          <select class="form-input" style="width:80px;padding:4px 6px;font-size:13px" onchange="updateCatCfg(${ci},'sets',parseInt(this.value))">
            <option value="1" ${cfg.sets===1?'selected':''}>1</option>
            <option value="3" ${cfg.sets===3?'selected':''}>3</option>
          </select>
        </div>
      </div>
      ${cfg.sets===3?catNumField('3rd set pts', ci, 'pointsThirdSet', cfg.pointsThirdSet||15, 11, 30):''}
      <div class="cat-sett-field">
        <span class="cat-sett-label">Start Time</span>
        <div class="cat-sett-ctrl">
          <input type="time" class="time-inp" style="width:100px" value="${cfg.startTime||'08:00'}" onchange="updateCatCfg(${ci},'startTime',this.value)"/>
        </div>
      </div>
    </div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <div class="cat-sett-label" style="margin-bottom:8px;font-size:10px;letter-spacing:2px">SCORING RULES</div>
      <table class="scoring-rules-tbl">
        <thead><tr><th>Stage</th><th>Pts to win</th><th>Switch @</th><th>Min</th></tr></thead>
        <tbody>
          ${[
            ['pool',  'Pool'],
            ['r16',   'R16 (שמינית)'],
            ['qf',    'QF (רבע)'],
            ['sf',    'SF (חצי)'],
            ['third', '3/4'],
            ['final', 'Final (גמר)'],
          ].map(([key, label]) => {
            const r = { ...DEF_KO_RULES[key], ...(cfg.koRules?.[key]||{}) };
            return `<tr>
              <td class="srt-label">${label}</td>
              <td><div class="cat-sett-ctrl">
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','pts',Math.max(11,(${r.pts||15})-1))">−</button>
                <span class="s-num-val">${r.pts||15}</span>
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','pts',Math.min(30,(${r.pts||15})+1))">+</button>
              </div></td>
              <td><div class="cat-sett-ctrl">
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','change',${r.change?r.change-1:null})">−</button>
                <span class="s-num-val">${r.change||'—'}</span>
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','change',${r.change?r.change+1:5})">+</button>
              </div></td>
              <td><div class="cat-sett-ctrl">
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','dur',Math.max(5,(${r.dur||cfg.gameDur||15})-5))">−</button>
                <span class="s-num-val">${r.dur||cfg.gameDur||15}</span>
                <button class="s-num-btn" onclick="updateKORuleField(${ci},'${key}','dur',Math.min(60,(${r.dur||cfg.gameDur||15})+5))">+</button>
              </div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
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
  }
  if (key==='name') {
    document.getElementById('header-name').textContent=val;
    document.title=val||'Tournaments';
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
  if (key === 'sport') renderAll();
  pushMetaOnly();
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
  if (!categories[ci].cfg) categories[ci].cfg = {...DEF_CAT_CFG};
  if (!categories[ci].cfg.koRules) categories[ci].cfg.koRules = {};
  if (!categories[ci].cfg.koRules[roundKey]) categories[ci].cfg.koRules[roundKey] = {...DEF_KO_RULES[roundKey]};
  categories[ci].cfg.koRules[roundKey][field] = val === '' || val === null ? null : Number(val);
  // Changing a stage's length shifts every slot after it — recompute the clock.
  if (field === 'dur') assignSlotTimes(categories[ci].id);
  pushToCloud();
  renderSettings();
}

function updateCatName(ci, val) {
  if (!categories[ci]) return;
  categories[ci].name=val;
  pushToCloud();
}
function updateCatCfg(ci, key, val) {
  if (!categories[ci]) return;
  if (!categories[ci].cfg) categories[ci].cfg={...DEF_CAT_CFG};
  categories[ci].cfg[key]=val;
  pushToCloud(); renderSettings();
}
function adjCatCfg(ci, key, delta, min, max) {
  if (!categories[ci]) return;
  if (!categories[ci].cfg) categories[ci].cfg={...DEF_CAT_CFG};
  const cur=categories[ci].cfg[key]||min;
  categories[ci].cfg[key]=Math.min(max,Math.max(min,cur+delta));
  pushToCloud(); renderSettings();
}

function addCategory() {
  const id='cat_'+Date.now();
  categories.push({ id, name:'New Category', cfg:{...DEF_CAT_CFG} });
  state[id]={ roster:[], groups:[], sched:[], ko:[] };
  pushToCloud(); renderSettings();
}
function deleteCategory(ci) {
  if (meta.phase === 'tournament') { alert('Cannot delete categories during an active tournament.'); return; }
  if (!confirm('Delete this category?')) return;
  const id=categories[ci].id;
  categories.splice(ci,1);
  delete state[id];
  pushToCloud(); renderSettings(); renderAll();
}

function resetAllScores() {
  if (!superAdmin||!confirm('Reset ALL scores?')) return;
  categories.forEach(cat => {
    const cs=state[cat.id];
    if (!cs) return;
    cs.sched.forEach(g=>{g.sa='';g.sb='';});
    cs.ko.forEach(r=>r.forEach(g=>{g.sa='';g.sb='';}));
  });
  pushToCloud(); renderAll();
}

// ============ NAV ============
function goPage(p) {
  if (p==='registrations' && (!admin || meta.phase !== 'registration')) return;
  if (p==='build' && (!admin || (meta.phase !== 'registration' && meta.phase !== 'built'))) return;
  if (p==='settings' && (!superAdmin || meta.phase === 'tournament')) return;
  document.querySelectorAll('.pg').forEach(e=>e.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('on'));
  const pageEl=document.getElementById('page-'+p);
  if (!pageEl) return;
  pageEl.classList.add('on');
  const tab=document.getElementById('tab-'+p);
  if (tab) tab.classList.add('on');
  renderCatFilters();
  if (p==='register')       renderRegisterPage();
  if (p==='participants')   renderParticipants();
  if (p==='registrations')  renderRegistrations();
  if (p==='build')          renderBuildPage();
  if (p==='standings')      renderStandings();
  if (p==='schedule')       { renderStats(); renderCourtFilter(); renderScheduleContent(); }
  if (p==='bracket')        renderBracket();
  if (p==='settings')       renderSettings();
}

function rerender() {
  renderCatFilters();
  const pages=['register','participants','registrations','build','standings','schedule','bracket','settings'];
  const active=pages.find(p=>{
    const el=document.getElementById('page-'+p);
    return el&&el.classList.contains('on');
  });
  if (active==='standings')     renderStandings();
  if (active==='schedule')      { renderStats(); renderCourtFilter(); renderScheduleContent(); }
  if (active==='bracket')       renderBracket();
  if (active==='settings')      renderSettings();
  if (active==='registrations') renderRegistrations();
  if (active==='build')         renderBuildPage();
  if (active==='participants')  renderParticipants();
  if (active==='register')      renderRegisterPage();
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
function renderAllInner() {
  applyTheme(meta.primaryColor, meta.secondaryColor);
  applyGroupColors();
  applyLogo(meta.logoUrl);
  document.getElementById('header-name').textContent = meta.name||'Tournament';
  document.title = meta.name||'Tournaments';
  const ll=document.getElementById('logo-letter');
  if (ll) ll.textContent=(meta.name||'T')[0].toUpperCase();

  document.body.classList.toggle('phase-registration', meta.phase === 'registration');
  document.body.classList.toggle('phase-built',        meta.phase === 'built');
  document.body.classList.toggle('phase-tournament',   meta.phase === 'tournament');

  renderSponsorBar();
  renderCatFilters();
  refreshAdmin();
  renderRegisterPage();
  renderParticipants();
  renderStandings();
  renderStats();
  renderCourtFilter();
  renderScheduleContent();
  renderBracket();
  if (superAdmin) renderSettings();
}

// ============ EXPOSE GLOBALS ============
Object.assign(window, {
  adminClick, selectLoginRole, tryLogin, closeLogin,
  openStartModal, closeStartModal, confirmStartTournament,
  goPage, setCat, setCourt,
  submitRegistration, setRegStatus, setRegPaid, setRegFilter, selectRegCat,
  openAddPair, closeAddPair, saveAddPair,
  buildTournament, shuffleBuildRoster, moveBuildItem,
  onDragStart, onDragEnd, onDragOver, onDrop, onListDragOver, onListDrop,
  openEditTeam, closeEdit, saveEdit, deleteTeam,
  editBuildItem, deleteBuildItem,
  setGS, setKS, filterSchedule,
  updateMeta, updateCatName, updateCatCfg, adjCatCfg,
  addCategory, deleteCategory, resetAllScores,
  updateSponsorLogo, removeSponsorLogo, addSponsorLogo,
  updateCatColor, renameGroup, moveTeam,
  updateGroupColor, updateBgColor,
  updateKORuleField,
  addPlayerToDB, removePlayerFromDB, importPlayersFromTournament
});

// ============ PLAYER DATABASE ============
async function loadPlayerDB() {
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
  name = name?.trim(); if (!name) return;
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

function renderPlayerDBSection(container) {
  const sec = document.createElement('div');
  sec.className = 'sett-section';
  sec.innerHTML = `
    <div class="sett-section-title">Players Database</div>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <input class="text-inp" id="new-player-name" style="flex:1;min-width:120px" placeholder="Player name…"/>
      <input class="text-inp" id="new-player-phone" style="width:130px" placeholder="Phone (optional)"/>
      <button class="add-cat-btn" onclick="addPlayerToDB(document.getElementById('new-player-name').value,document.getElementById('new-player-phone').value);document.getElementById('new-player-name').value='';document.getElementById('new-player-phone').value=''">+ Add</button>
    </div>
    <div style="margin-bottom:10px">
      <button class="add-cat-btn" onclick="importPlayersFromTournament()" style="font-size:12px">
        ↓ Import all players from this tournament
      </button>
      <span style="font-size:11px;color:var(--text3);margin-left:8px">${playerDB.length} players</span>
    </div>
    <div class="player-db-list">${playerDB.length
      ? playerDB.map((p,i) => `
        <div class="player-db-row">
          <span class="player-db-name">${escH(p.name)}</span>
          <span class="player-db-phone">${escH(p.phone||'')}</span>
          <button class="team-del" onclick="removePlayerFromDB(${i})">✕</button>
        </div>`).join('')
      : '<p class="sett-empty-note">No players yet — click Import or add pairs via the modal.</p>'}
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
    alert(`Imported ${added} new players.`);
  } else {
    alert('All players are already in the database.');
  }
}

// Auto-add both players of a new pair to the DB
async function autoAddPairToDB(name) {
  if (!name) return;
  const parts = name.includes('/') ? name.split('/').map(s=>s.trim()) : [name];
  for (const p of parts) {
    if (p && !playerDB.find(x => x.name.toLowerCase() === p.toLowerCase())) {
      playerDB.push({ name: p, phone: '' });
    }
  }
  await savePlayerDB();
  updatePlayerDatalist();
}

// ============ BOOT ============
// Prevent pinch-to-zoom (iOS ignores user-scalable=no since iOS 10)
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

window.addEventListener('load', async () => {
  const ok = await loadTournament();
  if (!ok) return;

  activeCat = null;
  firebaseReady = true;
  loadPlayerDB(); // load player database in background
  document.getElementById('view-loading').classList.add('h');
  document.getElementById('view-app').classList.remove('h');

  renderAll();

  goPage(meta.phase === 'registration' ? 'register' : 'standings');
});
