// tournaments.html?club=<id> — public list of a club's approved tournaments, in the club's brand.
import { db, escH as esc, doc, getDoc, applyTheme, applyBrandFonts } from './common.js?v=76';
import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const clubId = new URLSearchParams(location.search).get('club') || '';
const $ = id => document.getElementById(id);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }) : 'תאריך יפורסם';
let all = [], branches = [], fBranch = '', fLevel = '', showPast = false;
const seatsLeft = {};   // tournament id → free seats over its capped categories

function status(t) {
  if (t.meta?.phase === 'tournament') return ['live', 'הטורניר מתקיים'];
  if (t.meta?.phase === 'registration' && t.meta?.regOpen) {
    const left = seatsLeft[t.id];
    return left == null ? ['open', 'ההרשמה פתוחה'] : left > 0 ? ['open', `נשארו ${left} מקומות`] : ['wait', 'מלא · רשימת המתנה'];
  }
  return ['closed', 'ההרשמה סגורה'];
}

function render() {
  const bName = id => branches.find(b => b.id === id)?.name || '';
  const levels = [...new Set(all.flatMap(t => (t.categories || []).map(c => c.name)))];
  $('f-branch').innerHTML = [['', 'כל הסניפים'], ...branches.filter(b => all.some(t => t.branchId === b.id)).map(b => [b.id, b.name])]
    .map(([v, n]) => `<button type="button" class="pill${v === fBranch ? ' on' : ''}" aria-pressed="${v === fBranch}" onclick="setBranch('${esc(v)}')">${esc(n)}</button>`).join('');
  $('f-level').innerHTML = levels.length < 2 ? '' : [['', 'כל הרמות'], ...levels.map(l => [l, l])]
    .map(([v, n]) => `<button type="button" class="pill${v === fLevel ? ' on' : ''}" aria-pressed="${v === fLevel}" onclick="setLevel('${esc(v)}')">${esc(n)}</button>`).join('');

  const list = all.filter(t => (showPast ? (t.meta?.eventDate || '') < today : (t.meta?.eventDate || '9') >= today)
    && (!fBranch || t.branchId === fBranch)
    && (!fLevel || (t.categories || []).some(c => c.name === fLevel)));
  if (showPast) list.reverse();
  $('list').innerHTML = list.length ? list.map(t => {
    const [cls, txt] = status(t);
    const href = `index.html?t=${encodeURIComponent(t.id)}`;
    return `<article class="t-card">
      <div class="t-date">${esc(fmtDate(t.meta?.eventDate))}</div>
      <h2>${esc(t.meta?.name)}</h2>
      <div class="t-meta">${esc(bName(t.branchId))}${t.meta?.venue && t.meta.venue !== bName(t.branchId) ? ' · ' + esc(t.meta.venue) : ''}${t.meta?.price ? ` · ${esc(t.meta.price)} ₪ לזוג` : ''}</div>
      <div class="t-cats">${(t.categories || []).map(c => `<span class="chip">${esc(c.name)}</span>`).join('')}</div>
      <div class="t-foot"><span class="st ${cls}">${txt}</span>
        <a class="cta" href="${esc(href)}">${cls === 'open' ? 'להרשמה' : cls === 'wait' ? 'לרשימת ההמתנה' : cls === 'live' ? 'ללוח המשחקים' : 'לפרטים'}</a></div>
    </article>`;
  }).join('') : `<p class="empty">${showPast ? 'אין טורנירים קודמים להצגה.' : 'אין כרגע טורנירים קרובים. בקרוב יתפרסמו חדשים.'}</p>`;
  $('past-btn').textContent = showPast ? 'לטורנירים הקרובים' : 'טורנירים קודמים';
}

Object.assign(window, {
  setBranch: v => { fBranch = v; render(); },
  setLevel: v => { fLevel = v; render(); },
  togglePast: () => { showPast = !showPast; render(); },
});

(async () => {
  try {
    const club = (await getDoc(doc(db, 'clubs', clubId))).data();
    if (!club) throw new Error('club');
    const b = club.brand || {};
    if (b.primary) applyTheme(b.primary, b.secondary, { hasLogo: !!b.logo, neutralText: b.neutralText });
    applyBrandFonts(b.fonts);
    if (b.logo) { $('logo').src = b.logo; $('logo').classList.remove('h'); }
    $('logo').alt = club.name;
    document.title = `טורנירים · ${club.name}`;
    $('club').textContent = club.name;
    const [bs, ts] = await Promise.all([
      getDocs(collection(db, 'clubs', clubId, 'branches')),
      getDocs(query(collection(db, 'tournaments'), where('clubId', '==', clubId), where('approval', '==', 'approved'))),
    ]);
    branches = bs.docs.map(d => ({ id: d.id, ...d.data() }));
    all = ts.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((x, y) => (x.meta?.eventDate || '9').localeCompare(y.meta?.eventDate || '9'));
    render();
    // Free seats only where every category has a cap (otherwise "open" says it all).
    await Promise.all(all.filter(t => (t.meta?.eventDate || '9') >= today && t.meta?.regOpen
      && (t.categories || []).length && t.categories.every(c => Number(c.cfg?.maxPairs) > 0)).map(async t => {
      const regs = (await getDocs(query(collection(db, 'tournaments', t.id, 'registrations'), where('status', '==', 'approved')))).docs.map(d => d.data());
      seatsLeft[t.id] = t.categories.reduce((n, c) => n + Math.max(0, c.cfg.maxPairs - regs.filter(r => r.category === c.id).length), 0);
    }));
    render();
  } catch (e) {
    $('list').innerHTML = '<p class="empty">לא הצלחנו לטעון את הטורנירים. נסו לרענן.</p>';
  }
})();
