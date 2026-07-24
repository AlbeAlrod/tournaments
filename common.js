// ============================================================================
// common.js — shared foundation for the tournament app (app.js) and the
// league app (league.js).
//
// Holds the four things both apps need: Firebase init, sha256, HTML escaping,
// and the theme engine with automatic WCAG contrast.
//
// Everything here was lifted verbatim (behaviour-for-behaviour) from app.js so
// that adopting it there later is a pure deletion, not a rewrite. The one
// change: applyTheme() no longer reads the module-level `meta` global — the
// caller passes what it needs. See applyTheme() below.
//
// app.js still carries its own copies today. Migrating it is a separate,
// separately-verified change: app.js runs live events and a silent regression
// there is expensive.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Re-exported so callers get the SDK through one door and cannot accidentally
// pin a different Firebase version in a second import.
export { doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp };

// ============ FIREBASE ============
const firebaseConfig = {
  apiKey: "AIzaSyA-rPlg0Oau16QcTjD20hDfkyveRSrD8I0",
  authDomain: "tournaments-33619.firebaseapp.com",
  projectId: "tournaments-33619",
  storageBucket: "tournaments-33619.firebasestorage.app",
  messagingSenderId: "409384565600",
  appId: "1:409384565600:web:61bd55676343d6035abc05"
};
export const fbApp = initializeApp(firebaseConfig);
export const db    = getFirestore(fbApp);

// ============ HTML ESCAPE ============
export const escH = s => String(s||'')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ============ SHA-256 ============
export async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ============ FOCUS PRESERVATION ACROSS RE-RENDERS ============
// Any re-render that rebuilds innerHTML destroys the focused input and its
// caret. Snapshot before, restore after. Lifted from app.js:2841-2861, which
// earned it the hard way — see the "focus loss while typing" commits.
export function focusSnapshot() {
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

export function focusRestore(f) {
  if (!f) return;
  let el = null;
  try { el = document.querySelector(f.sel); } catch(_) {}
  if (!el || el === document.activeElement) return;
  try {
    el.focus({ preventScroll: true });
    if (f.s != null && el.setSelectionRange) el.setSelectionRange(f.s, f.e);
  } catch(_) {}
}

// ============ COLOR MATH ============
export function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3),16),
    parseInt(hex.slice(3,5),16),
    parseInt(hex.slice(5,7),16)
  ];
}

export function hexToHsl(hex) {
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

export function hslToHex(h,s,l) {
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
export function luminance(hex) {
  return hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  }).reduce((sum,v,i) => sum + v * [0.2126,0.7152,0.0722][i], 0);
}

// Contrast ratio (WCAG 2.1)
export function contrast(hex1, hex2) {
  const l1=luminance(hex1), l2=luminance(hex2);
  return (Math.max(l1,l2)+0.05) / (Math.min(l1,l2)+0.05);
}

// Adjust lightness until contrast vs bg meets ratio (min 4.5 = WCAG AA)
export function readable(candidate, bg, minRatio=4.5) {
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

// White or dark text on a colored background (buttons, net headers, chips)
export function onColor(bgHex) {
  return contrast('#FFFFFF', bgHex) >= 4.5 ? '#FFFFFF' : '#1a1a1a';
}

// ============ THEME ============
// Writes the whole CSS-variable palette derived from two brand colors.
//
// Differs from app.js only in its third argument: app.js read `meta.bgColor`
// and `meta.logoUrl` off a module global. Here the caller passes them, which is
// what makes the function shareable.
export function applyTheme(primary, secondary, opts = {}) {
  const { bgColor = '', hasLogo = false } = opts;

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
  document.body.style.backgroundColor = bgColor || '';

  const lm = document.getElementById('logo-mark');
  // With a real logo image, don't tint the chip — a dark logo would vanish on a dark primary.
  if (lm) {
    if (hasLogo) { lm.style.background='transparent'; lm.style.boxShadow='none'; lm.style.width='auto'; lm.style.overflow='visible'; }
    else { lm.style.background=primary; lm.style.boxShadow=''; lm.style.width=''; lm.style.overflow=''; }
  }
}
