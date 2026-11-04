import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });
initializeApp();
const db = getFirestore();
const auth = getAuth();

const fail = (code, msg) => { throw new HttpsError(code, msg); };
const str = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

export function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '').replace(/^00/, '+');
  if (/^\+?9725\d{8}$/.test(d)) d = '0' + d.replace(/^\+?972/, '');
  if (/^05\d{8}$/.test(d)) return d;
  return /^\+\d{8,15}$/.test(d) ? d : '';
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const canManage = (tk, t, tId) => !!tk && (
  tk.role === 'super' ||
  (!!tk.club && tk.club === t.clubId && (tk.role === 'owner' || (tk.role === 'branch' && tk.branch === t.branchId))) ||
  tk.tid === tId);

// At most `max` calls per `windowSec` for one key; counters live in a collection no client can read.
async function rateLimit(key, max, windowSec) {
  const ref = db.collection('rateLimits').doc(key.replace(/\//g, '_'));
  const now = Date.now();
  const ok = await db.runTransaction(async tx => {
    const d = (await tx.get(ref)).data();
    if (!d || now - d.start > windowSec * 1000) { tx.set(ref, { start: now, n: 1 }); return true; }
    if (d.n >= max) return false;
    tx.update(ref, { n: d.n + 1 });
    return true;
  });
  if (!ok) fail('resource-exhausted', 'too-many-attempts');
}

async function secureTournament(tId) {
  if (!str(tId, 100)) fail('invalid-argument', 'tId');
  const snap = await db.doc(`tournaments/${tId}`).get();
  const t = snap.data();
  if (!t || t.secure !== true) fail('not-found', 'tournament');
  return t;
}

const ROLES = ['admin', 'master'];

export const tournamentLogin = onCall(async req => {
  const { tId, role, password } = req.data || {};
  if (!ROLES.includes(role) || !str(password, 200)) fail('invalid-argument', 'input');
  await rateLimit(`login:${tId}:${req.rawRequest.ip}`, 10, 900);
  await secureTournament(tId);
  const secrets = (await db.doc(`tournaments/${tId}/private/secrets`).get()).data() || {};
  if (!verifyPassword(password, secrets[role])) fail('permission-denied', 'wrong-password');
  return { token: await auth.createCustomToken(`t_${tId}_${role}`, { tid: tId, trole: role }) };
});

export const setTournamentPassword = onCall(async req => {
  const { tId, role, password } = req.data || {};
  if (!ROLES.includes(role) || str(password, 200).length < 6) fail('invalid-argument', 'input');
  const t = await secureTournament(tId);
  const tk = req.auth?.token;
  if (!canManage(tk, t, tId) || tk.trole === 'admin') fail('permission-denied', 'not-manager');
  await db.doc(`tournaments/${tId}/private/secrets`).set({ [role]: hashPassword(password) }, { merge: true });
  return { ok: true };
});

// super → anyone; owner → branch managers of his club; branch manager → his own branch.
export const inviteManager = onCall(async req => {
  const tk = req.auth?.token;
  const email = str(req.data?.email, 200).toLowerCase();
  const { role, clubId, branchId } = req.data || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !['owner', 'branch'].includes(role) || !str(clubId, 100)) fail('invalid-argument', 'input');
  if (role === 'branch' && !str(branchId, 100)) fail('invalid-argument', 'branchId');
  const allowed = tk?.role === 'super' ||
    (role === 'branch' && tk?.club === clubId && (tk.role === 'owner' || (tk.role === 'branch' && tk.branch === branchId)));
  if (!allowed) fail('permission-denied', 'not-allowed');
  if (!(await db.doc(`clubs/${clubId}`).get()).exists) fail('not-found', 'club');
  if (role === 'branch' && !(await db.doc(`clubs/${clubId}/branches/${branchId}`).get()).exists) fail('not-found', 'branch');

  const user = await auth.getUserByEmail(email).catch(() => auth.createUser({ email }));
  const claims = role === 'owner' ? { role, club: clubId } : { role, club: clubId, branch: branchId };
  await auth.setCustomUserClaims(user.uid, claims);
  await db.doc(`users/${user.uid}`).set({ email, ...claims, invitedBy: req.auth.uid, invitedAt: FieldValue.serverTimestamp() });
  return { link: await auth.generatePasswordResetLink(email) };
});

export const registerPair = onCall(async req => {
  const { tId, category } = req.data || {};
  const p1 = str(req.data?.p1, 30), p2 = str(req.data?.p2, 30);
  const phone = normPhone(req.data?.phone);
  const email = str(req.data?.email, 200).toLowerCase();
  if (!p1 || !p2 || !phone || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('invalid-argument', 'input');
  await rateLimit(`reg:${req.rawRequest.ip}`, 20, 3600);
  const t = await secureTournament(tId);
  if (t.approval !== 'approved' || !t.meta?.regOpen || t.meta?.phase !== 'registration') fail('failed-precondition', 'closed');
  const cat = (t.categories || []).find(c => c.id === category);
  if (!cat) fail('invalid-argument', 'category');
  const cap = Number(cat.cfg?.maxPairs) || 0;

  const tRef = db.doc(`tournaments/${tId}`);
  const idxRef = tRef.collection('private').doc('phones');
  const regRef = tRef.collection('registrations').doc();
  // A full category (approved pairs hold the seats) takes new pairs onto the waitlist: no payment until approved.
  const status = await db.runTransaction(async tx => {
    const idx = (await tx.get(idxRef)).data() || {};
    const mine = idx[phone] || [];
    if (mine.some(r => r.category === category)) fail('already-exists', 'duplicate');
    const taken = cap ? (await tx.get(tRef.collection('registrations')
      .where('category', '==', category).where('status', '==', 'approved'))).size : 0;
    const status = cap && taken >= cap ? 'waitlist' : 'pending';
    tx.create(regRef, { p1, p2, category, status, paid: false, createdAt: FieldValue.serverTimestamp(),
      ...(status === 'waitlist' && { waitAt: Date.now() }) });
    tx.create(regRef.collection('private').doc('contact'), { phone, email });
    tx.set(idxRef, { [phone]: [...mine, { id: regRef.id, category }] }, { merge: true });
    return status;
  });
  return { id: regRef.id, status };
});

export const checkRegistration = onCall(async req => {
  const { tId } = req.data || {};
  const phone = normPhone(req.data?.phone);
  if (!phone) fail('invalid-argument', 'phone');
  await rateLimit(`check:${req.rawRequest.ip}`, 30, 3600);
  await secureTournament(tId);
  const refs = ((await db.doc(`tournaments/${tId}/private/phones`).get()).data()?.[phone] || [])
    .map(r => db.doc(`tournaments/${tId}/registrations/${r.id}`));
  const snaps = refs.length ? await db.getAll(...refs) : [];
  return { registrations: snaps.filter(s => s.exists).map(s => {
    const { p1, p2, category, status, paid, payDeadline } = s.data();
    return { id: s.id, p1, p2, category, status, paid, payDeadline: payDeadline || null };
  }) };
});

// A removed registration frees its phone for that category and takes its contact details with it.
export const onRegistrationDeleted = onDocumentDeleted('tournaments/{tId}/registrations/{rId}', async ev => {
  const { tId, rId } = ev.params;
  const tRef = db.doc(`tournaments/${tId}`);
  const contact = tRef.collection('registrations').doc(rId).collection('private').doc('contact');
  const phone = (await contact.get()).data()?.phone;
  await contact.delete();
  if (!phone) return;
  const idxRef = tRef.collection('private').doc('phones');
  await db.runTransaction(async tx => {
    const left = ((await tx.get(idxRef)).data()?.[phone] || []).filter(r => r.id !== rId);
    tx.update(idxRef, { [phone]: left.length ? left : FieldValue.delete() });
  });
});
export * from './mail.js';
