// uploader.js — pick / drop / paste an image, resize + compress it in the browser,
// and hand back a data URL small enough to store in the tournament doc (meta).
// Pre-Auth decision (see WORKPLAN.md): max 512px, target < 80KB, WebP (PNG fallback),
// SVG rejected. Storage-backed uploads come in phase 5.
//
// Errors are user-facing strings:
//   pickImage()          → rejects with Error(message); a cancelled picker rejects with
//                          an Error whose .cancelled === true (callers should ignore it).
//   attachDropZone(...)  → calls onImage(null, message).

const DEFAULTS = { maxPx: 512, maxBytes: 80000 };

const ERR = {
  notImage: 'Please choose an image file (PNG, JPG or WebP).',
  svg:      'SVG files are not supported — please use PNG, JPG or WebP.',
  decode:   "Couldn't read this image. Try saving it as PNG or JPG.",
  tooBig:   "Couldn't make this image small enough. Try a simpler or smaller image.",
  huge:     'This file is too large (max 15 MB).',
};

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
      img.onerror = () => reject(new Error(ERR.decode));
      img.src = url;
    });
  } finally {
    // The decoded <img> keeps its pixels; revoking after load is safe.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function render(src, w, h, type, quality) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c.toDataURL(type, quality);
}

/**
 * Resize + compress one File/Blob. Resolves to a data URL (image/webp or image/png).
 * Never upscales. Keeps transparency.
 */
export async function processImageFile(file, { maxPx = DEFAULTS.maxPx, maxBytes = DEFAULTS.maxBytes } = {}) {
  if (!file) throw new Error(ERR.notImage);
  if (isSvg(file)) throw new Error(ERR.svg);
  if (!/^image\//i.test(file.type || '')) throw new Error(ERR.notImage);
  if (file.size > 15 * 1024 * 1024) throw new Error(ERR.huge);

  let src;
  try { src = await decode(file); } catch (_) { throw new Error(ERR.decode); }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error(ERR.decode);

  const webp = supportsWebp();
  const type = webp ? 'image/webp' : 'image/png';
  let scale = Math.min(1, maxPx / Math.max(sw, sh));

  try {
    // Shrink dimensions until it fits; for WebP also step quality down at each size.
    for (let attempt = 0; attempt < 12; attempt++) {
      const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
      const qualities = webp ? [0.9, 0.8, 0.7, 0.6, 0.5] : [undefined];
      for (const q of qualities) {
        const out = render(src, w, h, type, q);
        if (dataUrlBytes(out) <= maxBytes) return out;
      }
      if (Math.max(w, h) <= 48) break;
      scale *= 0.8;
    }
  } finally {
    if (typeof src.close === 'function') src.close();   // ImageBitmap
  }
  throw new Error(ERR.tooBig);
}

/**
 * Open the file picker and resolve to a compressed data URL.
 */
export function pickImage({ maxPx = DEFAULTS.maxPx, maxBytes = DEFAULTS.maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.style.display = 'none';
    const cancelled = () => { const e = new Error('cancelled'); e.cancelled = true; return e; };
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return reject(cancelled());
      processImageFile(f, { maxPx, maxBytes }).then(resolve, reject);
    });
    // Modern browsers fire 'cancel'; older ones simply never settle the promise,
    // which is harmless: nothing is locked while the picker is open.
    inp.addEventListener('cancel', () => { inp.remove(); reject(cancelled()); });
    document.body.appendChild(inp);
    inp.click();
  });
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

  const handle = async p => {
    el.setAttribute('aria-busy', 'true');
    try { onImage(await p, null); }
    catch (e) { if (!e || !e.cancelled) onImage(null, (e && e.message) || ERR.decode); }
    finally { el.removeAttribute('aria-busy'); }
  };
  const firstImage = list => [...(list || [])].find(it => it && it.kind === 'file' && /^image\//.test(it.type || ''));

  const onClick = e => { if (e.target.closest('button,a,input')) return; handle(pickImage(opts)); };
  const onKey = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle(pickImage(opts)); } };
  const onOver = e => { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); el.classList.add('d-drop-over'); };
  const onLeave = () => el.classList.remove('d-drop-over');
  const onDrop = e => {
    e.preventDefault(); el.classList.remove('d-drop-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return onImage(null, ERR.notImage);
    handle(processImageFile(f, opts));
  };
  const onPaste = e => {
    const items = e.clipboardData && e.clipboardData.items;
    const it = firstImage(items);
    const f = it && it.getAsFile ? it.getAsFile() : null;
    if (!f) return;   // plain text paste — leave it alone
    e.preventDefault();
    handle(processImageFile(f, opts));
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
