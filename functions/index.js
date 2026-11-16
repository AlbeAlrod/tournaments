import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createHash, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });
initializeApp();
const db = getFirestore();

const fail = (code, msg) => { throw new HttpsError(code, msg); };
const sha256 = s => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

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

// config/superAdmin.password is the super-admin's SHA-256 hash (admin.html). Clients can
// read but never write it, so it is a trustworthy check. Tournament passwords in meta are
// NOT: legacy tournament documents are writable by anyone.
async function isSuper(password) {
  const expected = (await db.doc('config/superAdmin').get()).data()?.password;
  return !!expected && !!password && sha256(password) === expected;
}

// The super-admin gives a tournament's managers a password for reading its waivers.
export const setWaiverPassword = onCall(async req => {
  const { tId, superPassword, password } = req.data || {};
  if (typeof tId !== 'string' || !tId || typeof password !== 'string' || password.length < 6) fail('invalid-argument', 'input');
  await rateLimit(`wpw:${req.rawRequest.ip}`, 10, 900);
  if (!await isSuper(superPassword)) fail('permission-denied', 'wrong-password');
  await db.doc(`tournaments/${tId}/private/secrets`).set({ waivers: hashPassword(password) }, { merge: true });
  return { ok: true };
});

// Signed waivers of one tournament, for its managers (waiver password) or the super-admin.
export const listWaivers = onCall(async req => {
  const { tId, password } = req.data || {};
  if (typeof tId !== 'string' || !tId || typeof password !== 'string' || !password) fail('invalid-argument', 'input');
  await rateLimit(`wls:${tId}:${req.rawRequest.ip}`, 10, 900);
  const secret = (await db.doc(`tournaments/${tId}/private/secrets`).get()).data()?.waivers;
  if (!verifyPassword(password, secret) && !await isSuper(password)) fail('permission-denied', 'wrong-password');
  const snap = await db.collection('waivers').where('tId', '==', tId).get();
  return { waivers: snap.docs.map(d => {
    const w = d.data();
    return { id: d.id, regId: w.regId, player: w.player, fullName: w.fullName, idNum: w.idNum, phone: w.phone,
      consentPhotos: w.consentPhotos, signature: w.signature, version: w.version,
      signedAt: w.signedAt?.toDate?.().toISOString() || null };
  }) };
});
