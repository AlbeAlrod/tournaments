// Waiver block (text, participant details, consent, drawn signature) used by the
// registration form (player 1) and by the signing dialog (any player, via link).
import { WAIVERS } from './waiver-text.js?v=1';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const waiverFor = id => WAIVERS[id] || null;

// Israeli ID: up to 9 digits with a Luhn-style check digit.
export function validIsraeliId(v) {
  const id = String(v ?? '').replace(/\D/g, '');
  if (!id || id.length > 9 || !Number(id)) return false;
  let sum = 0;
  [...id.padStart(9, '0')].forEach((c, i) => { const d = Number(c) * (i % 2 + 1); sum += d > 9 ? d - 9 : d; });
  return sum % 10 === 0;
}

// p: id prefix · w: waiver · opts: { name, askPhone, tName, tDate, note }
export function waiverHTML(p, w, opts) {
  const f = (k, label, inner) => `<div class="form-row"><label for="${p}-${k}">${label}</label>${inner}<div id="${p}-${k}-err" class="fld-err h"></div></div>`;
  return `<section class="waiver" aria-labelledby="${p}-title">
  <h3 id="${p}-title" class="waiver-h">${esc(w.title)}</h3>
  ${opts.note ? `<p class="d-muted">${esc(opts.note)}</p>` : ''}
  <div class="waiver-text" tabindex="0" role="document" aria-label="${esc(w.title)}">
    <p><strong>${esc(w.org)}</strong></p>
    <p><strong>${esc(w.subtitle)}</strong> · ${esc(opts.tName || '')}${opts.tDate ? ' · ' + esc(opts.tDate) : ''}</p>
    <p><strong>חתימה על כתב ויתור זה מהווה תנאי סף להשתתפות בטורניר.</strong></p>
    ${w.body}
  </div>
  ${f('name', 'שם מלא', `<input class="form-input" id="${p}-name" dir="auto" autocomplete="name" maxlength="60" value="${esc(opts.name)}"/>`)}
  ${f('id', 'מספר תעודת זהות', `<input class="form-input" id="${p}-id" dir="ltr" inputmode="numeric" autocomplete="off" maxlength="9"/>`)}
  ${opts.askPhone ? f('phone', 'מספר טלפון', `<input class="form-input" id="${p}-phone" type="tel" dir="ltr" inputmode="tel" placeholder="050-0000000" autocomplete="tel"/>`) : ''}
  <div class="form-row">
    <label class="waiver-check"><input type="checkbox" id="${p}-agree"/> <span><strong>אישור חובה:</strong> ${esc(w.agree)}</span></label>
    <div id="${p}-agree-err" class="fld-err h"></div>
  </div>
  <fieldset class="form-row waiver-photo">
    <legend>הסכמה נפרדת לצילום ולשימוש בחומרים</legend>
    <label class="waiver-check"><input type="radio" name="${p}-photo" value="yes"/> <span>${esc(w.photoYes)}</span></label>
    <label class="waiver-check"><input type="radio" name="${p}-photo" value="no"/> <span>${esc(w.photoNo)}</span></label>
    <p class="d-muted">${esc(w.photoNote)}</p>
    <div id="${p}-photo-err" class="fld-err h"></div>
  </fieldset>
  <div class="form-row">
    <label id="${p}-sig-lbl">חתימה (באצבע או בעכבר)</label>
    <canvas id="${p}-sig" class="waiver-sig" role="img" aria-labelledby="${p}-sig-lbl"></canvas>
    <button type="button" class="reg-btn" id="${p}-sig-clear">ניקוי חתימה</button>
    <div id="${p}-sig-err" class="fld-err h"></div>
  </div>
  <p class="d-muted">תאריך: ${new Date().toLocaleDateString('he-IL')}</p>
</section>`;
}

const pads = {};
export function initWaiver(p) {
  const canvas = document.getElementById(`${p}-sig`);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  Object.assign(ctx, { lineWidth: 2.2, lineCap: 'round', lineJoin: 'round', strokeStyle: '#111111' });
  const pad = { empty: true, canvas, w, h };
  let last = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); last = pos(e); });
  canvas.addEventListener('pointermove', e => {
    if (!last) return;
    const p2 = pos(e);
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p2); ctx.stroke();
    last = p2; pad.empty = false;
  });
  const end = () => { last = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  document.getElementById(`${p}-sig-clear`).onclick = () => { ctx.clearRect(0, 0, w, h); pad.empty = true; };
  pads[p] = pad;
}

const setErr = (p, k, msg) => {
  const el = document.getElementById(`${p}-${k}-err`);
  if (el) { el.textContent = msg || ''; el.classList.toggle('h', !msg); }
};

// → { data } or { error: <first field key> }. phone comes from opts when not asked here.
export function readWaiver(p, w, { phone, normPhone }) {
  const v = k => document.getElementById(`${p}-${k}`)?.value.trim() ?? '';
  const name = v('name').replace(/\s+/g, ' ');
  const idNum = v('id').replace(/\D/g, '');
  const ph = document.getElementById(`${p}-phone`) ? normPhone(v('phone')) : phone;
  const photo = document.querySelector(`input[name="${p}-photo"]:checked`)?.value;
  const errs = {
    name: name.split(' ').length < 2 ? 'יש למלא שם פרטי ושם משפחה.' : '',
    id: validIsraeliId(idNum) ? '' : 'מספר תעודת הזהות אינו תקין.',
    phone: document.getElementById(`${p}-phone`) && !ph ? 'יש להזין מספר נייד תקין.' : '',
    agree: document.getElementById(`${p}-agree`)?.checked ? '' : 'יש לאשר שקראת את כתב הוויתור ושאת/ה מסכים/ה לו.',
    photo: photo ? '' : 'יש לבחור אחת מהאפשרויות.',
    sig: pads[p] && !pads[p].empty ? '' : 'יש לחתום במסגרת.',
  };
  Object.entries(errs).forEach(([k, m]) => setErr(p, k, m));
  const first = Object.keys(errs).find(k => errs[k]);
  if (first) { document.getElementById(`${p}-${first === 'photo' ? 'title' : first}`)?.scrollIntoView({ block: 'center' }); return { error: first }; }
  // Export the strokes at 1x so the stored image stays small.
  const pad = pads[p], out = document.createElement('canvas');
  out.width = pad.w; out.height = pad.h;
  out.getContext('2d').drawImage(pad.canvas, 0, 0, pad.w, pad.h);
  return { data: { fullName: name, idNum, phone: ph, agreed: true, consentPhotos: photo === 'yes', signature: out.toDataURL('image/png'), version: w.version } };
}

// Signing dialog for a player who did not sign during registration (the partner, via link).
export function openSignDialog({ w, name, tName, tDate, onSubmit }) {
  closeSignDialog();
  const el = document.createElement('div');
  el.id = 'waiver-modal';
  el.className = 'waiver-modal';
  el.innerHTML = `<div class="waiver-modal-box" role="dialog" aria-modal="true" aria-labelledby="wm-title">
    ${waiverHTML('wm', w, { name, askPhone: true, tName, tDate, note: `חתימה בשם ${name}. כל שחקן/ית חותם/ת בעצמו/ה.` })}
    <div id="wm-err" class="frm-err h" role="alert"></div>
    <div class="waiver-modal-btns">
      <button type="button" class="submit-btn" id="wm-submit">חתימה ושליחה</button>
      <button type="button" class="reg-btn" id="wm-cancel">ביטול</button>
    </div></div>`;
  document.body.appendChild(el);
  initWaiver('wm');
  document.getElementById('wm-cancel').onclick = closeSignDialog;
  document.getElementById('wm-submit').onclick = async () => {
    const btn = document.getElementById('wm-submit');
    if (btn.disabled) return;
    btn.disabled = true;
    try { await onSubmit(); }
    catch (e) {
      const err = document.getElementById('wm-err');
      err.textContent = 'השליחה נכשלה. בדקו את החיבור ונסו שוב.';
      err.classList.remove('h');
    }
    btn.disabled = false;
  };
  document.getElementById('wm-name')?.focus();
}
export function closeSignDialog() { document.getElementById('waiver-modal')?.remove(); delete pads.wm; }
