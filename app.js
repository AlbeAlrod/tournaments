import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, addDoc, getDocs, updateDoc, query, orderBy
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
const auth  = getAuth(fbApp);

const EMAIL_ADMIN  = 'vl.admin@tournaments.app';
const EMAIL_MASTER = 'vl.master@tournaments.app';

// ============ URL PARAM ============
const tId = new URLSearchParams(location.search).get('t');

// ============ STATE ============
let meta = { name:'', logoUrl:'', primaryColor:'#6B21A8', secondaryColor:'#7C3AED', paymentLink:'', phase:'registration', regOpen:true, showRegistered:true };
let categories = [];   // [{id, name, cfg}]
let state = {};        // {[catId]: {roster:[], groups:[], sched:[], ko:[]}}
let registrations = [];// [{id, p1, p2, phone, category, status, paid, createdAt}]

let adminLevel = 0;    // 0=view 1=admin(scores) 2=master(full)
let admin = false;
let superAdmin = false;
let loginRole = 'admin';

let activeCat = null;  // selected category id for tournament views
let regFilter = 'all'; // pending|approved|rejected|all
let schedFilter = [];
let activeCourt = 'all';
let applyingRemote = false;
let firebaseReady = false;

let TREF = null;
let REGS_REF = null;

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
  try {
    await setDoc(TREF, {
      meta, categories,
      state: stateObj,
      updatedAt: serverTimestamp()
    }, { merge: true });
    setSyncStatus(true);
  } catch(e) {
    console.error('Push error', e);
    setSyncStatus(false);
  }
}

async function pushMetaOnly() {
  if (!TREF) return;
  try {
    await setDoc(TREF, { meta, updatedAt: serverTimestamp() }, { merge: true });
    setSyncStatus(true);
  } catch(e) { setSyncStatus(false); }
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
  const [r2,g2,b2] = hexToRgb(secondary);
  const [h2,s2,l2] = hexToHsl(secondary);

  // ── Backgrounds (light tint of primary hue) ──
  const bgL  = Math.max(95, 98 - s1*0.04);
  const bg3L = Math.max(90, bgL - 5);
  const surL = Math.max(84, bgL - 10);
  const bg   = hslToHex(h1, Math.min(s1*0.35, 22), bgL);
  const bg3  = hslToHex(h1, Math.min(s1*0.45, 28), bg3L);
  const surf = hslToHex(h1, Math.min(s1*0.55, 35), surL);

  // ── Text: start from dark hue variants, then force contrast ──
  const rawText  = hslToHex(h1, Math.min(s1*0.6,  60), Math.max(6,  l1*0.22));
  const rawText2 = hslToHex(h1, Math.min(s1*0.75, 80), Math.max(16, l1*0.45));
  const rawText3 = hslToHex(h1, Math.min(s1,     100), Math.min(l1, 52));
  const text  = readable(rawText,  bg, 7.0);  // body text — strict
  const text2 = readable(rawText2, bg, 5.0);  // headings
  const text3 = readable(rawText3, bg, 4.5);  // secondary text

  // ── primary3 for tab / label text on light nav bg ──
  const rawP3 = hslToHex(h2, Math.min(s2*0.85, 88), Math.min(l2, 55));
  const primary3 = readable(rawP3, bg3, 4.5);

  // ── Text color on colored backgrounds (buttons, group headers, bracket) ──
  // Use average of primary+secondary since most backgrounds are their gradient
  const midLum = (luminance(primary) + luminance(secondary)) / 2;
  // ── Text on colored backgrounds: always white + dark shadow scaled by lightness ──
  // shadowStr: 0 for dark backgrounds (no shadow needed), up to 0.9 for very light ones
  const shadowStr = Math.max(0, Math.min(0.9, (midLum - 0.04) * 1.8));
  const onPrimaryShadow = shadowStr > 0.06
    ? `0 1px 3px rgba(0,0,0,${shadowStr.toFixed(2)}),` +
      `0 0 6px rgba(0,0,0,${(shadowStr * 0.5).toFixed(2)}),` +
      `-1px 0 2px rgba(0,0,0,${(shadowStr * 0.4).toFixed(2)}),` +
      ` 1px 0 2px rgba(0,0,0,${(shadowStr * 0.4).toFixed(2)})`
    : 'none';

  // ── Header / nav ──
  const [rB,gB,bB]   = hexToRgb(bg);
  const [rB3,gB3,bB3] = hexToRgb(bg3);

  const vars = {
    '--primary':            primary,
    '--primary2':           secondary,
    '--primary3':           primary3,
    '--bg':                 bg,
    '--bg2':                '#FFFFFF',
    '--bg3':                bg3,
    '--surface':            surf,
    '--border':             `rgba(${r1},${g1},${b1},0.13)`,
    '--border2':            `rgba(${r1},${g1},${b1},0.28)`,
    '--text':               text,
    '--text2':              text2,
    '--text3':              text3,
    '--on-primary':         '#FFFFFF',
    '--on-primary-shadow':  onPrimaryShadow,
    '--header-bg':          `rgba(${rB},${gB},${bB},0.95)`,
    '--nav-bg':             `rgba(${rB3},${gB3},${bB3},0.96)`,
    '--modebar-bg':         `rgba(${r1},${g1},${b1},0.07)`,
    '--modebar-admin-bg':   `linear-gradient(90deg,rgba(${r1},${g1},${b1},.12),rgba(${r2},${g2},${b2},.10))`,
  };

  const style = document.getElementById('theme-style') || (() => {
    const s=document.createElement('style'); s.id='theme-style'; document.head.appendChild(s); return s;
  })();
  style.textContent = `:root{${Object.entries(vars).map(([k,v])=>`${k}:${v};`).join('')}}`;

  // Logo mark gets gradient of both colors
  const lm = document.getElementById('logo-mark');
  if (lm) lm.style.background = `linear-gradient(135deg,${primary},${secondary})`;
}

// ============ AUTH ============
function adminClick() {
  if (admin) {
    signOut(auth);
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
  document.getElementById('role-btn-admin').style.cssText  = loginRole === 'admin'  ? on : off;
  document.getElementById('role-btn-master').style.cssText = loginRole === 'master' ? on : off;
}

async function tryLogin() {
  const val   = document.getElementById('pw-inp').value.trim();
  const email = loginRole === 'master' ? EMAIL_MASTER : EMAIL_ADMIN;
  try {
    await signInWithEmailAndPassword(auth, email, val);
    adminLevel = loginRole === 'master' ? 2 : 1;
    admin      = true;
    superAdmin = adminLevel === 2;
    closeLogin(); refreshAdmin(); rerender();
  } catch(e) {
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
  document.body.classList.toggle('admin-mode', superAdmin);
  const txt = document.getElementById('adm-txt');
  const btn = document.getElementById('abtn');
  const bar = document.getElementById('mode-bar');
  const mtxt = document.getElementById('mode-text');
  if (txt) txt.textContent = adminLevel === 2 ? 'Master ✓' : adminLevel === 1 ? 'Admin ✓' : 'Admin';
  if (btn) btn.classList.toggle('on', admin);
  if (bar) bar.className = 'mode-bar ' + (admin ? 'mode-admin' : 'mode-view');
  if (mtxt) mtxt.textContent = adminLevel === 2
    ? 'Master mode — full access'
    : adminLevel === 1 ? 'Admin mode — score entry only'
    : 'View only — tap Admin to manage';
  // Master doesn't need the public Register tab
  const regTab = document.getElementById('tab-register');
  if (regTab) regTab.classList.toggle('h', superAdmin);
  // If master landed on register page, redirect to registrations
  if (superAdmin && document.getElementById('page-register')?.classList.contains('on')) {
    goPage('registrations');
  }
}

// ============ REGISTRATION ============
async function submitRegistration() {
  const p1   = document.getElementById('frm-p1').value.trim();
  const p2   = document.getElementById('frm-p2').value.trim();
  const phone = document.getElementById('frm-phone').value.trim();
  const catId = document.getElementById('frm-cat').value;
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
  } catch(e) {
    err.textContent = 'Submission failed. Please try again.';
    err.classList.remove('h');
  }
}

async function setRegStatus(id, status) {
  if (!superAdmin) return;
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { status });
    const r = registrations.find(r => r.id === id);
    if (r) r.status = status;
    renderRegistrations();
    renderParticipants();
  } catch(e) { alert('Error updating status'); }
}

async function setRegPaid(id, paid) {
  if (!superAdmin) return;
  try {
    await updateDoc(doc(db, 'tournaments', tId, 'registrations', id), { paid });
    const r = registrations.find(r => r.id === id);
    if (r) r.paid = paid;
    renderRegistrations();
  } catch(e) {}
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
        <div class="reg-name">${r.p1}${r.p2 ? ' / ' + r.p2 : ''}</div>
        <div class="reg-meta">${catName} · ${new Date(r.createdAt?.seconds*1000||0).toLocaleDateString()}</div>
        <div class="reg-phone">${r.phone||'—'}</div>
      </div>
      <span class="status-badge badge-${r.status}">${r.status}</span>
      ${r.paid ? '<span class="status-badge badge-paid">Paid</span>' : ''}
      <div class="reg-actions">
        ${r.status !== 'approved' ? `<button class="reg-btn approve" onclick="setRegStatus('${r.id}','approved')">Approve</button>` : ''}
        ${r.status !== 'rejected' ? `<button class="reg-btn reject" onclick="setRegStatus('${r.id}','rejected')">Reject</button>` : ''}
        ${!r.paid ? `<button class="reg-btn" onclick="setRegPaid('${r.id}',true)">Mark Paid</button>` : `<button class="reg-btn" onclick="setRegPaid('${r.id}',false)">Unpaid</button>`}
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
  renderPayLink('participants-pay-wrap');
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
      <div class="part-cat-title">${cat.name}</div>
      <div class="part-grid">${list.map((r,i) => `
        <div class="part-card">
          <span class="part-num">${i+1}</span>
          <span class="part-name">${r.p1}${r.p2 ? ' / '+r.p2 : ''}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderPayLink(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  if (meta.paymentLink) {
    wrap.className = 'pay-wrap';
    wrap.innerHTML = `<p>Payment</p>
      <a class="pay-btn" href="${meta.paymentLink}" target="_blank" rel="noopener">💳 Pay Now</a>`;
  } else {
    wrap.className = 'pay-wrap h';
    wrap.innerHTML = '';
  }
}

function renderRegisterPage() {
  const closedMsg  = document.getElementById('reg-closed-msg');
  const formWrap   = document.getElementById('reg-form-wrap');
  const sub        = document.getElementById('reg-subtitle');
  const catSelect  = document.getElementById('frm-cat');
  if (!meta.regOpen) {
    closedMsg?.classList.remove('h');
    if (formWrap) formWrap.style.display = 'none';
  } else {
    closedMsg?.classList.add('h');
    if (formWrap) formWrap.style.display = '';
  }
  if (sub) sub.textContent = meta.name ? `Register for ${meta.name}` : '';
  if (catSelect) {
    catSelect.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  renderPayLink('reg-pay-wrap');
}

// ============ BUILD PAGE ============
let dragSrc = null;

function renderBuildPage() {
  const el = document.getElementById('build-cats');
  if (!el) return;
  el.innerHTML = '';
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
    div.innerHTML = `
      <div class="build-cat-head">
        <span class="build-cat-name">${cat.name}</span>
        <span class="build-cat-count">${roster.length} pairs</span>
      </div>
      <div class="build-list" id="blist-${cat.id}" data-cat="${cat.id}">
        ${roster.map((name,i) => buildItem(cat.id, name, i)).join('')}
      </div>
      <div class="build-foot">
        <button class="build-btn" onclick="buildTournament('${cat.id}')">▶ Build Tournament</button>
        <button class="build-shuffle" onclick="shuffleBuildRoster('${cat.id}')">🔀 Shuffle</button>
        <button class="build-add-pair" onclick="openAddPair('${cat.id}')">+ Add Pair</button>
      </div>`;
    el.appendChild(div);
    setupDragDrop(cat.id);
  });
}

function buildItem(catId, name, i) {
  return `<div class="build-item" draggable="true" data-cat="${catId}" data-idx="${i}"
    ondragstart="onDragStart(event)" ondragover="onDragOver(event)"
    ondrop="onDrop(event,'${catId}')" ondragend="onDragEnd(event)">
    <span class="build-rank">${i+1}</span>
    <span class="build-name">${name}</span>
    <button class="gedit-btn" onclick="editBuildItem('${catId}',${i})" title="Edit">Edit</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},-1)" title="Up">↑</button>
    <button class="build-arrow" onclick="moveBuildItem('${catId}',${i},1)" title="Down">↓</button>
    <button class="team-del" onclick="deleteBuildItem('${catId}',${i})" title="Remove">✕</button>
  </div>`;
}

function editBuildItem(catId, idx) {
  if (!superAdmin) return;
  editTarget = { catId, buildIdx: idx };
  const name = state[catId]?.roster[idx] || '';
  const parts = name.split('/').map(s => s.trim());
  document.getElementById('edit-p1').value = parts[0] || '';
  document.getElementById('edit-p2').value = parts[1] || '';
  document.getElementById('edit-modal-title').textContent = 'Edit Pair';
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}

function deleteBuildItem(catId, idx) {
  if (!superAdmin) return;
  state[catId].roster.splice(idx, 1);
  pushToCloud();
  renderBuildPage();
}

function setupDragDrop(catId) {}

function onDragStart(e) {
  dragSrc = e.currentTarget;
  dragSrc.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
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
function onDrop(e, catId) {
  e.preventDefault();
  const target = e.currentTarget;
  if (!dragSrc || dragSrc === target) return;
  const fromIdx = parseInt(dragSrc.dataset.idx);
  const toIdx   = parseInt(target.dataset.idx);
  const cs = state[catId];
  if (!cs) return;
  const roster = [...cs.roster];
  const [moved] = roster.splice(fromIdx, 1);
  roster.splice(toIdx, 0, moved);
  cs.roster = roster;
  pushToCloud();
  renderBuildPage();
}

function moveBuildItem(catId, idx, dir) {
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
  renderBuildPage();
}

function openAddPair(catId) {
  document.getElementById('ap-cat').innerHTML = categories.map(c =>
    `<option value="${c.id}" ${c.id===catId?'selected':''}>${c.name}</option>`).join('');
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
  await loadRegistrations();
  closeAddPair();
  renderBuildPage();
}

async function buildTournament(catId) {
  if (!superAdmin) return;
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cat || !cs) return;

  let roster = cs.roster.length ? cs.roster :
    registrations.filter(r => r.status === 'approved' && r.category === catId)
      .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));

  if (!roster.length) { alert('No approved pairs in this category.'); return; }

  const cfg = cat.cfg;
  const ng  = cfg.numGroups || 2;
  const sizes = distributeGroups(roster.length, ng);
  const groups = [];
  let idx = 0;
  for (let g = 0; g < ng; g++) {
    groups.push({ name: String.fromCharCode(65+g), teams: roster.slice(idx, idx+sizes[g]) });
    idx += sizes[g];
  }
  cs.roster = roster;
  cs.groups = groups;
  cs.sched  = [];
  cs.ko     = [];
  generateScheduleForCat(catId);

  // Check if all categories are built; if so flip phase
  const allBuilt = categories.every(c => (state[c.id]?.groups||[]).length > 0);
  if (allBuilt) {
    meta.phase = 'tournament';
    document.body.classList.remove('phase-registration');
    document.body.classList.add('phase-tournament');
  }

  await pushToCloud();
  renderAll();
  if (allBuilt) goPage('standings');
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
  return roundName(cs.ko[ri].length * 2);
}

function generateScheduleForCat(catId) {
  const cs  = state[catId];
  const cat = categories.find(c => c.id === catId);
  if (!cs || !cat) return;
  const cfg = cat.cfg;
  const slotDur = (cfg.gameDur||30) + (cfg.breakDur||0);
  const nc = cfg.courts || 2;

  const courtQueues = {};
  cs.groups.forEach((grp, gi) => {
    const court = (gi % nc) + 1;
    if (!courtQueues[court]) courtQueues[court] = [];
    rr(grp.teams).forEach(([a,b]) => {
      courtQueues[court].push({ catId, gi, gn:grp.name, a, b, sa:'', sb:'', court });
    });
  });

  const courts = Object.keys(courtQueues).map(Number).sort((a,b)=>a-b);
  const maxGames = Math.max(...courts.map(c => courtQueues[c].length));
  const scheduled = [];
  for (let si=0; si<maxGames; si++) {
    courts.forEach(court => {
      if (si < courtQueues[court].length) {
        const g = courtQueues[court][si];
        g.si   = si;
        g.time = addM(cfg.startTime||'08:00', si*slotDur);
        scheduled.push(g);
      }
    });
  }
  cs.sched = scheduled;

  const adv = cfg.advPerGroup || 0;
  const ng  = cs.groups.length;
  if (adv < 1) { cs.ko = []; return; }

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
}

// ============ SCORE VALIDATION ============
function isValidScore(sa, sb, catId) {
  if (isNaN(sa)||isNaN(sb)||sa===''||sb==='') return false;
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  if (cfg.sets === 3) {
    const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
    return (hi===2 && lo>=0 && lo<=1);
  }
  const ptw = cfg.pointsToWin || 21;
  if (sa===sb) return false;
  const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
  if (hi < ptw) return false;
  if (hi===ptw) return hi-lo>=2;
  return hi-lo===2;
}

function scoreError(sa, sb, catId) {
  if (sa===''||sb==='') return null;
  const a=parseInt(sa), b=parseInt(sb);
  if (isNaN(a)||isNaN(b)) return null;
  const cat = categories.find(c=>c.id===catId);
  const cfg = cat?.cfg || DEF_CAT_CFG;
  if (cfg.sets===3) {
    const hi=Math.max(a,b), lo=Math.min(a,b);
    if (hi>2||lo<0) return 'Sets won: 2:0 or 2:1';
    if (hi!==2) return 'Winner must have 2 sets';
    return null;
  }
  const ptw = cfg.pointsToWin||21;
  const hi=Math.max(a,b), lo=Math.min(a,b);
  if (hi===lo) return `Scores can't be equal`;
  if (hi<ptw) return `Must reach ${ptw} · e.g. ${ptw}–${lo}`;
  if (hi===ptw && hi-lo<2) return `Need 2-point lead`;
  if (hi>ptw && hi-lo!==2) return `Above ${ptw}: exactly 2 apart`;
  return null;
}

// ============ STANDINGS ============
function getStandings(catId, gi) {
  const cs  = state[catId];
  if (!cs) return [];
  const grp = cs.groups[gi];
  const rec = {};
  grp.teams.forEach(t => rec[t]={w:0,l:0,pts:0,scored:0,against:0});
  cs.sched.filter(g=>g.gi===gi).forEach(g => {
    const sa=parseInt(g.sa), sb=parseInt(g.sb);
    if (!isValidScore(sa, sb, catId)) return;
    if (rec[g.a]) { rec[g.a].scored+=sa; rec[g.a].against+=sb; }
    if (rec[g.b]) { rec[g.b].scored+=sb; rec[g.b].against+=sa; }
    if (sa>sb) {
      if (rec[g.a]) { rec[g.a].w++; rec[g.a].pts+=2; }
      if (rec[g.b]) { rec[g.b].l++; rec[g.b].pts+=1; }
    } else {
      if (rec[g.b]) { rec[g.b].w++; rec[g.b].pts+=2; }
      if (rec[g.a]) { rec[g.a].l++; rec[g.a].pts+=1; }
    }
  });
  return grp.teams.map(t => ({name:t,...rec[t],diff:(rec[t].scored-rec[t].against)}))
    .sort((a,b) => b.pts-a.pts||b.w-a.w||b.diff-a.diff||b.scored-a.scored);
}

function makeStandingsCard(catId, grp, gi) {
  const cs  = state[catId];
  const cfg = categories.find(c=>c.id===catId)?.cfg || DEF_CAT_CFG;
  const adv = cfg.advPerGroup||1;
  const st  = getStandings(catId, gi);
  const totalGames = (grp.teams.length*(grp.teams.length-1))/2;
  const played = cs.sched.filter(g=>g.gi===gi && isValidScore(parseInt(g.sa),parseInt(g.sb),catId)).length;
  const poolDone = played===totalGames && totalGames>0;
  const card = document.createElement('div');
  card.className = 'scard';
  const rows = st.map((t,i) => {
    const isWinner = i<adv && poolDone;
    const diff = t.diff||0;
    const diffStr = diff>0?`+${diff}`:String(diff);
    const diffClass = diff>0?'diff-pos':diff<0?'diff-neg':'diff-zero';
    const ti = cs.groups[gi].teams.indexOf(t.name);
    const adminCtrls = superAdmin
      ? `<td><button class="gedit-btn" onclick="openEditTeam('${catId}',${gi},${ti})">Edit</button>
         <button class="team-del" onclick="deleteTeam('${catId}',${gi},${ti})">✕</button></td>` : '';
    return `<tr class="${isWinner?'winner':''}">
      <td><span class="rnk">#${i+1}</span>${t.name}</td>
      <td>${t.w}</td><td>${t.l}</td>
      <td class="${diffClass}">${diff!==0||t.w>0||t.l>0?diffStr:'—'}</td>
      <td class="pts-val">${t.pts}</td>
      ${adminCtrls}
    </tr>`;
  }).join('');
  const adminTh = superAdmin ? '<th></th>' : '';
  card.innerHTML = `<div class="scard-head"><span class="scard-name">GROUP ${grp.name}</span></div>
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
    if (cats.length > 1) {
      const hdr = document.createElement('div');
      hdr.className = 'cat-section-header';
      hdr.textContent = cat.name;
      grid.appendChild(hdr);
    }
    const sub = document.createElement('div');
    sub.className = 'stnds-subgrid';
    cs.groups.forEach((grp, gi) => sub.appendChild(makeStandingsCard(cat.id, grp, gi)));
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
  const parts = name.split('/').map(s=>s.trim());
  document.getElementById('edit-p1').value = parts[0]||'';
  document.getElementById('edit-p2').value = parts[1]||'';
  document.getElementById('edit-modal-title').textContent = `Edit — Group ${state[catId].groups[gi].name}`;
  document.getElementById('edit-modal').classList.remove('h');
  document.getElementById('edit-p1').focus();
}
function closeEdit() {
  document.getElementById('edit-modal').classList.add('h');
  editTarget = null;
}
function saveEdit() {
  if (!superAdmin||!editTarget) return;
  const p1 = document.getElementById('edit-p1').value.trim();
  const p2 = document.getElementById('edit-p2').value.trim();
  const name = p2?`${p1} / ${p2}`:p1;
  if (!name) return;

  // Build page roster edit
  if (editTarget.buildIdx !== undefined) {
    state[editTarget.catId].roster[editTarget.buildIdx] = name;
    closeEdit(); pushToCloud(); renderBuildPage();
    return;
  }

  // Standings group team edit
  const {catId,gi,ti} = editTarget;
  const old = state[catId].groups[gi].teams[ti];
  state[catId].groups[gi].teams[ti] = name;
  state[catId].sched.forEach(g => { if(g.a===old)g.a=name; if(g.b===old)g.b=name; });
  state[catId].ko.forEach(r => r.forEach(g => { if(g.a===old)g.a=name; if(g.b===old)g.b=name; }));
  closeEdit(); pushToCloud(); renderStandings();
}
function deleteTeam(catId, gi, ti) {
  if (!superAdmin) return;
  const grp = state[catId].groups[gi];
  if (grp.teams.length<=1) { alert('Group needs at least 1 team'); return; }
  grp.teams.splice(ti,1);
  pushToCloud(); renderStandings();
}

// ============ SCORES ============
function setGS(catId, idx, k, v) {
  if (!admin) return;
  state[catId].sched[idx][k] = v;
  const g = state[catId].sched[idx];
  const err = scoreError(g.sa, g.sb, catId);
  const errEl = document.getElementById(`gerr-${catId}-${idx}`);
  if (errEl) { errEl.textContent=err||''; errEl.style.display=err?'block':'none'; }
  if (!err) { updateKOForCat(catId); pushToCloud(); renderStandings(); }
}
function setKS(catId, ri, gi, k, v) {
  if (!admin) return;
  state[catId].ko[ri][gi][k] = v;
  const g = state[catId].ko[ri][gi];
  const err = scoreError(g.sa, g.sb, catId);
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
  const done = cs.sched.filter(g=>g.gi===gi&&isValidScore(parseInt(g.sa),parseInt(g.sb),catId)).length;
  if (done!==totalGames) return { label:seed, known:false };
  const st = getStandings(catId, gi);
  if (!st[rank-1]) return { label:seed, known:false };
  return { label:st[rank-1].name, known:true };
}

function getKOWinner(game, catId) {
  if (!game) return null;
  const sa=parseInt(game.sa), sb=parseInt(game.sb);
  if (isValidScore(sa,sb,catId)) return sa>sb?game.a:game.b;
  return null;
}

function updateKOForCat(catId) {
  const cs  = state[catId];
  if (!cs||!cs.ko.length) return;
  const cfg = categories.find(c=>c.id===catId)?.cfg||DEF_CAT_CFG;
  const adv = cfg.advPerGroup||0;
  const ng  = cs.groups.length;
  const koSeeds = [];
  for (let rank=1; rank<=adv; rank++)
    for (let g=0; g<ng; g++)
      koSeeds.push(`${String.fromCharCode(65+g)}${rank}`);
  const nKO = koSeeds.length;
  const paired = [];
  for (let i=0; i<Math.floor(nKO/2); i++) paired.push([koSeeds[i], koSeeds[nKO-1-i]]);

  if (cs.ko[0]) {
    paired.forEach(([sA,sB],i) => {
      if (!cs.ko[0][i]) return;
      const rA = resolvePoolSeed(catId, sA);
      const rB = resolvePoolSeed(catId, sB);
      cs.ko[0][i].a = rA.known ? rA.label : sA;
      cs.ko[0][i].b = rB.known ? rB.label : sB;
    });
  }
  for (let ri=1; ri<cs.ko.length; ri++) {
    cs.ko[ri].forEach((g,gi) => {
      const wa = getKOWinner(cs.ko[ri-1][gi*2], catId);
      const wb = getKOWinner(cs.ko[ri-1][gi*2+1], catId);
      const rndName = getKORoundName(catId, ri-1);
      g.a = wa||`Winner of ${rndName} ${gi*2+1}`;
      g.b = wb||`Winner of ${rndName} ${gi*2+2}`;
    });
  }
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
    totalPool += cs.sched.length;
    donePool  += cs.sched.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),cat.id)).length;
    totalKO   += cs.ko.reduce((s,r)=>s+r.length, 0);
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
  const done = isValidScore(parseInt(g.sa),parseInt(g.sb),catId);
  const pc   = ['p1','p2','p3','p4'][(g.court-1)%4];
  const wrap = document.createElement('div');
  const row  = document.createElement('div');
  row.className = 'gc'+(done?' done':'');
  const scoreCell = admin
    ? `<input class="si" type="number" min="0" inputmode="numeric" placeholder="—" value="${g.sa}"
         onchange="${isKO?`setKS('${catId}',${g.ri},${g.gi},'sa',this.value)`:`setGS('${catId}',${idx},'sa',this.value)`}"/>
       <span class="ssep">:</span>
       <input class="si" type="number" min="0" inputmode="numeric" placeholder="—" value="${g.sb}"
         onchange="${isKO?`setKS('${catId}',${g.ri},${g.gi},'sb',this.value)`:`setGS('${catId}',${idx},'sb',this.value)`}"/>`
    : `<span class="ssep">${done?`${g.sa} : ${g.sb}`:'— : —'}</span>`;

  row.innerHTML = `
    <span class="pill ${pc}">C${g.court}</span>
    <span class="gt">${g.a}${!isKO&&g.gn?`<span class="gtag">${g.gn}</span>`:''}</span>
    <span class="gvs">vs</span>
    <span class="gt r">${g.b}</span>
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
      .filter(g=>activeCourt==='all'||g.court===activeCourt)
      .forEach(g=>allGames.push({...g,_catId:cat.id,_idx:-1,_isKO:true,_rn:getKORoundName(cat.id,g.ri)}));
  });
  if (!allGames.length) { el.innerHTML=`<div class="empty"><h3>No games</h3></div>`; return; }

  const inp = document.getElementById('sched-search');
  const q   = (inp?.value||'').trim().toLowerCase();
  const filtered = q
    ? allGames.filter(g => g.a.toLowerCase().includes(q)||g.b.toLowerCase().includes(q))
    : allGames;
  if (q && !filtered.length) {
    el.innerHTML=`<div class="empty"><h3>No match for "${q}"</h3></div>`; return;
  }

  const byTime = {};
  filtered.forEach(g => { const k=g.time||'00:00'; if(!byTime[k])byTime[k]=[]; byTime[k].push(g); });
  el.innerHTML = '';
  Object.keys(byTime).sort((a,b)=>t2m(a)-t2m(b)).forEach(time => {
    const games = byTime[time];
    const koGame = games.find(g=>g._isKO);
    const block = document.createElement('div');
    block.className='tblock';
    block.innerHTML=`<div class="thdr"><span class="tlbl">${time}</span><div class="tline"></div>${koGame?`<span class="rtag">${koGame._rn}</span>`:''}</div>`;
    games.forEach(g => block.appendChild(buildGameRow(g._catId, g, g._idx, g._isKO)));
    el.appendChild(block);
  });
}

function filterSchedule() { renderScheduleContent(); }

function renderCourtFilter() {
  const el = document.getElementById('court-filter');
  if (!el) return;
  const courts = new Set();
  const cats = activeCat ? categories.filter(c=>c.id===activeCat) : categories;
  cats.forEach(cat => {
    const cfg = cat.cfg||DEF_CAT_CFG;
    for (let i=1; i<=(cfg.courts||2); i++) courts.add(i);
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

  const done  = cs.sched.filter(g=>isValidScore(parseInt(g.sa),parseInt(g.sb),catId)).length;
  const total = cs.sched.length;
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

  cs.ko.forEach((round,ri) => {
    const col=document.createElement('div'); col.className='bround';
    col.innerHTML=`<div class="brnd-title">${getKORoundName(catId,ri)}</div>`;
    const matchesEl=document.createElement('div'); matchesEl.className='brnd-matches';
    matchesEl.style.paddingTop=(ri===0?0:((Math.pow(2,ri)-1)*HG/2))+'px';
    const matchGap=(Math.pow(2,ri)-1)*HG+GAP;

    round.forEach((g,gi) => {
      const wrap=document.createElement('div'); wrap.className='bmatch-wrap';
      if (gi>0) wrap.style.marginTop=matchGap+'px';
      const sa=parseInt(g.sa), sb=parseInt(g.sb);
      const hs=isValidScore(sa,sb,catId);
      const wa=hs&&sa>sb, wb=hs&&sb>sa;
      let labelA,labelB,codeA='',codeB='',knownA=false,knownB=false;
      if (ri===0) {
        const pair=gi<seedPairs.length?seedPairs[gi]:[g.seedA||'TBD',g.seedB||'TBD'];
        const sA=resolvePoolSeed(catId,pair[0]), sB=resolvePoolSeed(catId,pair[1]);
        labelA=sA.known?sA.label:pair[0]; labelB=sB.known?sB.label:pair[1];
        codeA=sA.known?pair[0]:''; codeB=sB.known?pair[1]:'';
        knownA=sA.known; knownB=sB.known;
      } else {
        const srcRound=getKORoundName(catId,ri-1);
        labelA=g.a&&!g.a.startsWith('Winner')?g.a:`Winner of ${srcRound} ${gi*2+1}`;
        labelB=g.b&&!g.b.startsWith('Winner')?g.b:`Winner of ${srcRound} ${gi*2+2}`;
        knownA=!!(g.a&&!g.a.startsWith('Winner'));
        knownB=!!(g.b&&!g.b.startsWith('Winner'));
      }
      const box=document.createElement('div'); box.className='bmatch-box';
      box.innerHTML=`<div class="bmatch">
        <div class="bteam ${wa?'win':''} ${knownA?'':'tbd'}">
          <span class="bname">${labelA}</span>${codeA?`<span class="bsc seed-tag">${codeA}</span>`:''}${hs?`<span class="bsc">${g.sa}</span>`:''}
        </div>
        <div class="bteam ${wb?'win':''} ${knownB?'':'tbd'}">
          <span class="bname">${labelB}</span>${codeB?`<span class="bsc seed-tag">${codeB}</span>`:''}${hs?`<span class="bsc">${g.sb}</span>`:''}
        </div>
      </div>`;
      wrap.appendChild(box); matchesEl.appendChild(wrap);
    });
    col.appendChild(matchesEl); tree.appendChild(col);
  });
  container.appendChild(scroll);

  const fin=cs.ko[cs.ko.length-1][0];
  if (fin) {
    const fsa=parseInt(fin.sa),fsb=parseInt(fin.sb);
    if (isValidScore(fsa,fsb,catId)) {
      const w=fsa>fsb?fin.a:fin.b;
      const champEl=document.createElement('div');
      champEl.innerHTML=`<div class="champ-wrap"><div class="ci">★ CHAMPION</div><div class="champ-name">${w}</div></div>`;
      container.appendChild(champEl);
    }
  }
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
  ['cat-filter','cat-filter-sched','cat-filter-bracket'].forEach(elId => {
    const el=document.getElementById(elId);
    if (!el) return;
    if (categories.length<=1) { el.innerHTML=''; return; }
    el.innerHTML=`<div class="cat-filter">
      <button class="cat-btn ${!activeCat?'on':''}" onclick="setCat(null)">All</button>
      ${categories.map(c=>`<button class="cat-btn ${activeCat===c.id?'on':''}" onclick="setCat('${c.id}')">${c.name}</button>`).join('')}
    </div>`;
  });
}

// ============ SETTINGS ============
function renderSettings() {
  const container=document.getElementById('settings-container');
  if (!container||!superAdmin) return;
  container.innerHTML='';

  // Tournament meta
  const metaSection=document.createElement('div');
  metaSection.className='sett-section';
  metaSection.innerHTML=`<div class="sett-section-title">Tournament</div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">Name</span></div>
      <div class="sett-ctrl"><input class="text-inp" value="${meta.name||''}" style="width:200px" onchange="updateMeta('name',this.value)"/></div>
    </div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">Logo URL</span></div>
      <div class="sett-ctrl"><input class="text-inp" value="${meta.logoUrl||''}" style="width:200px" placeholder="https://…" onchange="updateMeta('logoUrl',this.value)"/></div>
    </div>
    <div class="sett-row" style="align-items:flex-start;padding-top:16px">
      <div class="sett-label">
        <span class="sett-name">Colors</span>
        <span class="sett-desc">Two colors that together style the entire site — background, header, gradients, buttons.</span>
      </div>
      <div class="sett-ctrl" style="flex-direction:column;align-items:flex-end;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <label style="font-size:12px;color:var(--text3);font-weight:600;white-space:nowrap">Primary</label>
          <input type="color" class="color-inp" value="${meta.primaryColor||'#6B21A8'}"
            oninput="updateMeta('primaryColor',this.value)" style="width:52px;height:38px"/>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <label style="font-size:12px;color:var(--text3);font-weight:600;white-space:nowrap">Accent</label>
          <input type="color" class="color-inp" value="${meta.secondaryColor||meta.primaryColor||'#7C3AED'}"
            oninput="updateMeta('secondaryColor',this.value)" style="width:52px;height:38px"/>
        </div>
        <div style="width:114px;height:14px;border-radius:7px;
          background:linear-gradient(135deg,${meta.primaryColor||'#6B21A8'},${meta.secondaryColor||'#7C3AED'});
          box-shadow:0 2px 6px rgba(0,0,0,.18)"></div>
      </div>
    </div>
    <div class="sett-row">
      <div class="sett-label">
        <span class="sett-name">Payment Link</span>
        <span class="sett-desc">Shown to participants on the registration and participants pages.</span>
      </div>
      <div class="sett-ctrl"><input class="text-inp" value="${meta.paymentLink||''}" style="width:220px" placeholder="https://pay.example.com/…" onchange="updateMeta('paymentLink',this.value)"/></div>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Registration Open</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.regOpen?'checked':''} onchange="updateMeta('regOpen',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Show Participant List (public)</span>
      <label class="toggle-switch"><input type="checkbox" ${meta.showRegistered?'checked':''} onchange="updateMeta('showRegistered',this.checked)"/><span class="toggle-slider"></span></label>
    </div>
    <div class="sett-row">
      <div class="sett-label"><span class="sett-name">Phase</span><span class="sett-desc">Switch between registration and tournament mode.</span></div>
      <div class="sett-ctrl">
        <select class="form-input" style="width:160px" onchange="updateMeta('phase',this.value)">
          <option value="registration" ${meta.phase==='registration'?'selected':''}>Registration</option>
          <option value="tournament" ${meta.phase==='tournament'?'selected':''}>Tournament</option>
        </select>
      </div>
    </div>`;
  container.appendChild(metaSection);

  // Categories
  const catSection=document.createElement('div');
  catSection.className='sett-section';
  catSection.innerHTML=`<div class="sett-section-title">Categories</div>
    <div id="cat-list">${categories.map((cat,ci)=>renderCatItem(cat,ci)).join('')}</div>
    <button class="add-cat-btn" onclick="addCategory()">+ Add Category</button>`;
  container.appendChild(catSection);

  // Danger zone
  const danger=document.createElement('div');
  danger.className='sett-danger';
  danger.innerHTML=`<div class="sett-card-title" style="color:var(--red)">Danger Zone</div>
    <p style="font-size:13px;color:var(--text3);margin-bottom:14px">Reset all tournament scores.</p>
    <button class="danger-btn" onclick="resetAllScores()">Reset All Scores</button>`;
  container.appendChild(danger);
}

function renderCatItem(cat, ci) {
  const cfg=cat.cfg||DEF_CAT_CFG;
  return `<div class="cat-item">
    <div class="cat-item-head">
      <input class="text-inp" style="width:180px;font-weight:600" value="${cat.name}" onchange="updateCatName(${ci},this.value)"/>
      <button class="team-del" onclick="deleteCategory(${ci})" title="Delete">✕</button>
    </div>
    <div class="cat-settings-grid">
      ${catNumField('Courts', ci, 'courts', cfg.courts, 1, 8)}
      ${catNumField('Groups', ci, 'numGroups', cfg.numGroups, 2, 16)}
      ${catNumField('Adv/Group', ci, 'advPerGroup', cfg.advPerGroup, 1, 8)}
      ${catNumField('Game min', ci, 'gameDur', cfg.gameDur, 5, 120)}
      ${catNumField('Break min', ci, 'breakDur', cfg.breakDur, 0, 60)}
      ${catNumField('Pts to win', ci, 'pointsToWin', cfg.pointsToWin, 11, 99)}
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
    document.body.classList.toggle('phase-tournament', val==='tournament');
  }
  if (key==='regOpen') renderRegisterPage();
  if (key==='showRegistered') renderParticipants();
  if (key==='paymentLink') { renderRegisterPage(); renderParticipants(); }
  pushMetaOnly();
}

function applyLogo(url) {
  const img=document.getElementById('logo-img');
  const letter=document.getElementById('logo-letter');
  if (url) {
    img.src=url; img.style.display=''; if(letter)letter.style.display='none';
  } else {
    img.style.display='none'; if(letter)letter.style.display='';
  }
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
  if ((p==='settings'||p==='build'||p==='registrations') && !superAdmin) return;
  document.querySelectorAll('.pg').forEach(e=>e.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('on'));
  const pageEl=document.getElementById('page-'+p);
  if (!pageEl) return;
  pageEl.classList.add('on');
  const tab=document.getElementById('tab-'+p);
  if (tab) tab.classList.add('on');
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

function renderAll() {
  applyTheme(meta.primaryColor, meta.secondaryColor);
  applyLogo(meta.logoUrl);
  document.getElementById('header-name').textContent = meta.name||'Tournament';
  document.title = meta.name||'Tournaments';
  const ll=document.getElementById('logo-letter');
  if (ll) ll.textContent=(meta.name||'T')[0].toUpperCase();

  const isReg = meta.phase==='registration';
  document.body.classList.toggle('phase-registration', isReg);
  document.body.classList.toggle('phase-tournament', !isReg);

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
  goPage, setCat, setCourt,
  submitRegistration, setRegStatus, setRegPaid, setRegFilter,
  openAddPair, closeAddPair, saveAddPair,
  buildTournament, shuffleBuildRoster, moveBuildItem,
  onDragStart, onDragEnd, onDragOver, onDrop,
  openEditTeam, closeEdit, saveEdit, deleteTeam,
  editBuildItem, deleteBuildItem,
  setGS, setKS, filterSchedule,
  updateMeta, updateCatName, updateCatCfg, adjCatCfg,
  addCategory, deleteCategory, resetAllScores
});

// ============ BOOT ============
window.addEventListener('load', async () => {
  const ok = await loadTournament();
  if (!ok) return;

  await new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, user => {
      unsub();
      if (user) {
        if (user.email===EMAIL_MASTER)     { adminLevel=2; admin=true; superAdmin=true; }
        else if (user.email===EMAIL_ADMIN) { adminLevel=1; admin=true; superAdmin=false; }
      }
      resolve();
    });
  });

  activeCat = null;

  firebaseReady = true;
  document.getElementById('view-loading').classList.add('h');
  document.getElementById('view-app').classList.remove('h');

  renderAll();

  // Show first relevant page
  const isReg = meta.phase==='registration';
  if (isReg) goPage(superAdmin ? 'registrations' : 'register');
  else goPage('standings');
});
