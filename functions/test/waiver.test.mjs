import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { initializeApp as adminApp } from 'firebase-admin/app';
import { getFirestore as adminDb } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase/app';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const projectId = 'demo-luz';
adminApp({ projectId });
const adb = adminDb();
const fns = getFunctions(initializeApp({ projectId, apiKey: 'demo' }), 'europe-west1');
connectFunctionsEmulator(fns, '127.0.0.1', 5001);
const call = (name, data) => httpsCallable(fns, name)(data).then(r => r.data);
const code = async p => { try { await p; return 'ok'; } catch (e) { return e.code; } };
const sha = s => createHash('sha256').update(s).digest('hex');

let env;
const W = (extra = {}) => ({ tId: 'leg', regId: 'r1', player: 1, fullName: 'דנה כהן', idNum: '000000018', phone: '0501234567',
  agreed: true, consentPhotos: true, signature: 'data:image/png;base64,AAAA', version: 'volleylab-2026-11-16',
  tournamentName: 'T', tournamentDate: '2026-11-21', ua: 'test', signedAt: serverTimestamp(), ...extra });

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  await adb.doc('tournaments/leg').set({ meta: { name: 'T', waiver: 'volleylab', masterPassword: sha('master1') } });
  await adb.doc('config/superAdmin').set({ password: sha('superpw') });
});

test('rules: anyone can add a valid waiver, nobody can read or change one', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertSucceeds(setDoc(doc(db, 'waivers/w1'), W()));
  await assertFails(getDoc(doc(db, 'waivers/w1')));
  await assertFails(updateDoc(doc(db, 'waivers/w1'), { idNum: '123456782' }));
  await assertFails(setDoc(doc(db, 'waivers/w2'), W({ idNum: '12ab' })));
  await assertFails(setDoc(doc(db, 'waivers/w3'), W({ tId: 'nope' })));
  await assertFails(setDoc(doc(db, 'waivers/w4'), W({ agreed: false })));
  await assertFails(setDoc(doc(db, 'waivers/w5'), W({ extra: 1 })));
  await assertFails(getDoc(doc(db, 'tournaments/leg/private/secrets')));
});

test('viewing password: set only with the super-admin password, checked on the server', async () => {
  assert.equal(await code(call('setWaiverPassword', { tId: 'leg', superPassword: 'wrong', password: 'view123' })), 'functions/permission-denied');
  await call('setWaiverPassword', { tId: 'leg', superPassword: 'superpw', password: 'view123' });
  assert.ok(!JSON.stringify((await adb.doc('tournaments/leg/private/secrets').get()).data()).includes('view123'));

  assert.equal(await code(call('listWaivers', { tId: 'leg', password: 'master1' })), 'functions/permission-denied');
  const { waivers } = await call('listWaivers', { tId: 'leg', password: 'view123' });
  assert.equal(waivers.length, 1);
  assert.equal(waivers[0].idNum, '000000018');
  assert.ok(waivers[0].signature.startsWith('data:image/png'));
  assert.equal((await call('listWaivers', { tId: 'leg', password: 'superpw' })).waivers.length, 1);
});

test('listWaivers is rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await code(call('listWaivers', { tId: 'leg', password: 'bad' }));
  assert.equal(last, 'functions/resource-exhausted');
});
