// uploader.js — pick / drop / paste an image, resize + compress it in the browser,
// and hand back a data URL small enough to store in the tournament doc (meta).
// Pre-Auth decision (see WORKPLAN.md): max 512px, target < 80KB, WebP (without WebP:
// JPEG for opaque images, PNG only with transparency), SVG rejected. Storage-backed uploads come in phase 5.
//
// Errors are user-facing strings:
//   pickImage()          → rejects with Error(message); a cancelled picker rejects with
//                          an Error whose .cancelled === true (callers should ignore it).
//   attachDropZone(...)  → calls onImage(null, message).

import { t } from './i18n.js?v=68';

const DEFAULTS = { maxPx: 512, maxBytes: 80000 };

const fail = key => new Error(t('upload.' + key));

const isSvg = f => /svg/i.test(f.type || '') || /\.svgz?$/i.test(f.name || '');

// Approximate binary size of a base64 data URL.
const dataUrlBytes = u => Math.floor((u.length - u.indexOf(',') - 1) * 3 / 4);

let _webp = null;
function supportsWebp() {
  if (_webp === null) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      _webp = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch (_) { _webp = false; }
  }
  return _webp;
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (_) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(fail('decode'));
      img.src = url;
    });
  } finally {
    // The decoded <img> keeps its pixels; revoking after load is safe.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

function hasAlpha(src, w, h) {
  const px = draw(src, w, h).getContext('2d').getImageData(0, 0, w, h).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

/**
 * Resize + compress one File/Blob. Resolves to a data URL (image/webp, image/jpeg or image/png).
 * Never upscales. Keeps transparency.
 */
export async function processImageFile(file, { maxPx = DEFAULTS.maxPx, maxBytes = DEFAULTS.maxBytes } = {}) {
  if (!file) throw fail('notImage');
  if (isSvg(file)) throw fail('svg');
  if (!/^image\//i.test(file.type || '')) throw fail('notImage');
  if (file.size > 15 * 1024 * 1024) throw fail('huge');

  let src;
  try { src = await decode(file); } catch (_) { throw fail('decode'); }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw fail('decode');

  let scale = Math.min(1, maxPx / Math.max(sw, sh));
  const type = supportsWebp() ? 'image/webp'
    : hasAlpha(src, Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale))) ? 'image/png' : 'image/jpeg';
  const qualities = { 'image/webp': [0.9, 0.8, 0.7, 0.6, 0.5], 'image/jpeg': [0.85, 0.75, 0.6], 'image/png': [undefined] }[type];

  try {
    // Shrink dimensions until it fits; for WebP/JPEG also step quality down at each size.
    for (let attempt = 0; attempt < 12; attempt++) {
      const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
      const c = draw(src, w, h);
      for (const q of qualities) {
        const out = c.toDataURL(type, q);
        if (dataUrlBytes(out) <= maxBytes) return out;
      }
      if (Math.max(w, h) <= 48) break;
      scale *= 0.8;
    }
  } finally {
    if (typeof src.close === 'function') src.close();   // ImageBitmap
  }
  throw fail('tooBig');
}

// Opens the file picker; onFile(file) on a choice, onCancel() when the picker is dismissed.
function openPicker(onFile, onCancel = () => {}) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
  inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    f ? onFile(f) : onCancel();
  });
  // Modern browsers fire 'cancel'; older ones never settle, which locks nothing.
  inp.addEventListener('cancel', () => { inp.remove(); onCancel(); });
  document.body.appendChild(inp);
  inp.click();
}

/**
 * Open the file picker and resolve to a compressed data URL.
 */
export function pickImage({ maxPx = DEFAULTS.maxPx, maxBytes = DEFAULTS.maxBytes } = {}) {
  return new Promise((resolve, reject) => openPicker(
    f => processImageFile(f, { maxPx, maxBytes }).then(resolve, reject),
    () => { const e = new Error('cancelled'); e.cancelled = true; reject(e); }));
}

/**
 * Turn `el` into an image drop zone: drag & drop, click (or Enter/Space) to pick,
 * and paste while focused. Calls onImage(dataUrl, null) on success and
 * onImage(null, message) on error. Returns a function that detaches the listeners.
 */
export function attachDropZone(el, onImage, { maxPx = DEFAULTS.maxPx, maxBytes = DEFAULTS.maxBytes } = {}) {
  if (!el) return () => {};
  const opts = { maxPx, maxBytes };
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');

  const handle = async file => {
    el.setAttribute('aria-busy', 'true');
    try { onImage(await processImageFile(file, opts), null); }
    catch (e) { onImage(null, (e && e.message) || t('upload.decode')); }
    finally { el.removeAttribute('aria-busy'); }
  };
  const firstImage = list => [...(list || [])].find(it => it && it.kind === 'file' && /^image\//.test(it.type || ''));

  const onClick = e => { if (e.target.closest('button,a,input')) return; openPicker(handle); };
  const onKey = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(handle); } };
  const onOver = e => { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); el.classList.add('d-drop-over'); };
  const onLeave = () => el.classList.remove('d-drop-over');
  const onDrop = e => {
    e.preventDefault(); el.classList.remove('d-drop-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return onImage(null, t('upload.notImage'));
    handle(f);
  };
  const onPaste = e => {
    const items = e.clipboardData && e.clipboardData.items;
    const it = firstImage(items);
    const f = it && it.getAsFile ? it.getAsFile() : null;
    if (!f) return;   // plain text paste — leave it alone
    e.preventDefault();
    handle(f);
  };

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  el.addEventListener('dragover', onOver);
  el.addEventListener('dragenter', onOver);
  el.addEventListener('dragleave', onLeave);
  el.addEventListener('drop', onDrop);
  el.addEventListener('paste', onPaste);
  return () => {
    el.removeEventListener('click', onClick);
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('dragover', onOver);
    el.removeEventListener('dragenter', onOver);
    el.removeEventListener('dragleave', onLeave);
    el.removeEventListener('drop', onDrop);
    el.removeEventListener('paste', onPaste);
  };
}
