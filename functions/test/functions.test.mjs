import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp as adminApp } from 'firebase-admin/app';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { getFirestore as adminDb } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, updateDoc } from 'firebase/firestore';

const projectId = 'demo-luz';
adminApp({ projectId });
const adb = adminDb(), aauth = adminAuth();

const app = initializeApp({ projectId, apiKey: 'demo' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const fns = getFunctions(app, 'europe-west1');
connectFunctionsEmulator(fns, '127.0.0.1', 5001);
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);
const call = (name, data) => httpsCallable(fns, name)(data).then(r => r.data);
const code = async p => { try { await p; return 'ok'; } catch (e) { return e.code; } };

async function signInAs(uid, claims) {
  await signOut(auth);
  await signInWithCustomToken(auth, await aauth.createCustomToken(uid, claims));
}

const T = {
  secure: true, clubId: 'mentor', branchId: 'yafo', approval: 'approved',
  meta: { name: 'T', regOpen: true, phase: 'registration' },
  categories: [{ id: 'c1', name: 'BC' }, { id: 'c2', name: 'DE' }],
};
const pair = { tId: 'sec', p1: 'דנה', p2: 'רון', phone: '050-123-4567', email: 'Dana@Mail.com', category: 'c1' };

before(async () => {
  await adb.doc('tournaments/sec').set(T);
  await adb.doc('tournaments/closed').set({ ...T, meta: { ...T.meta, regOpen: false } });
  await adb.doc('tournaments/legacy').set({ meta: { name: 'L' } });
  await adb.doc('clubs/mentor').set({ name: 'מנטור' });
  await adb.doc('clubs/mentor/branches/yafo').set({ name: 'יפו' });
});

test('registerPair stores contact details privately and blocks duplicates', async () => {
  await signOut(auth);
  const { id } = await call('registerPair', pair);
  const pub = (await adb.doc(`tournaments/sec/registrations/${id}`).get()).data();
  assert.equal(pub.status, 'pending');
  assert.equal(pub.phone, undefined);
  assert.deepEqual((await adb.doc(`tournaments/sec/registrations/${id}/private/contact`).get()).data(),
    { phone: '0501234567', email: 'dana@mail.com' });
  assert.equal(await code(call('registerPair', pair)), 'functions/already-exists');
  assert.equal(await code(call('registerPair', { ...pair, category: 'c2' })), 'ok');
  assert.equal(await code(call('registerPair', { ...pair, tId: 'closed' })), 'functions/failed-precondition');
  assert.equal(await code(call('registerPair', { ...pair, tId: 'legacy' })), 'functions/not-found');
  assert.equal(await code(call('registerPair', { ...pair, email: 'nope' })), 'functions/invalid-argument');
});

test('a full category puts new pairs on the waitlist', async () => {
  await adb.doc('tournaments/cap').set({ ...T, categories: [{ id: 'c1', name: 'BC', cfg: { maxPairs: 1 } }] });
  const first = await call('registerPair', { ...pair, tId: 'cap', phone: '0521111111' });
  assert.equal(first.status, 'pending');
  await adb.doc(`tournaments/cap/registrations/${first.id}`).update({ status: 'approved' });
  const second = await call('registerPair', { ...pair, tId: 'cap', phone: '0522222222' });
  assert.equal(second.status, 'waitlist');
  assert.ok((await adb.doc(`tournaments/cap/registrations/${second.id}`).get()).data().waitAt > 0);
});

test('checkRegistration returns status without contact details', async () => {
  const { registrations } = await call('checkRegistration', { tId: 'sec', phone: '+972501234567' });
  assert.equal(registrations.length, 2);
  assert.deepEqual(Object.keys(registrations[0]).sort(), ['category', 'id', 'p1', 'p2', 'paid', 'payDeadline', 'status']);
  assert.equal((await call('checkRegistration', { tId: 'sec', phone: '0529999999' })).registrations.length, 0);
});

test('deleting a registration frees the phone for that category', async () => {
  const { registrations } = await call('checkRegistration', { tId: 'sec', phone: '0501234567' });
  const r = registrations.find(x => x.category === 'c1');
  await adb.doc(`tournaments/sec/registrations/${r.id}`).delete();
  for (let i = 0; i < 50 && await code(call('registerPair', pair)) !== 'ok'; i++) await new Promise(res => setTimeout(res, 200));
  const after = await call('checkRegistration', { tId: 'sec', phone: '0501234567' });
  assert.equal(after.registrations.filter(x => x.category === 'c1').length, 1);
});

test('tournament password is checked on the server and grants only that tournament', async () => {
  await signOut(auth);
  assert.equal(await code(call('setTournamentPassword', { tId: 'sec', role: 'admin', password: 'secret1' })), 'functions/permission-denied');
  await signInAs('own', { role: 'owner', club: 'mentor' });
  await call('setTournamentPassword', { tId: 'sec', role: 'admin', password: 'secret1' });
  const stored = (await adb.doc('tournaments/sec/private/secrets').get()).data().admin;
  assert.ok(!stored.includes('secret1'));

  await signOut(auth);
  assert.equal(await code(call('tournamentLogin', { tId: 'sec', role: 'admin', password: 'wrong' })), 'functions/permission-denied');
  const { token } = await call('tournamentLogin', { tId: 'sec', role: 'admin', password: 'secret1' });
  await signInWithCustomToken(auth, token);
  assert.equal(await code(updateDoc(doc(db, 'tournaments/sec'), { 'meta.name': 'ok' })), 'ok');
  assert.equal(await code(updateDoc(doc(db, 'tournaments/closed'), { 'meta.name': 'no' })), 'permission-denied');
  assert.equal(await code(call('setTournamentPassword', { tId: 'sec', role: 'master', password: 'x123456' })), 'functions/permission-denied');
});

test('inviteManager: super invites owners, owners invite branch managers of their club', async () => {
  await signOut(auth);
  assert.equal(await code(call('inviteManager', { email: 'o@m.co', role: 'owner', clubId: 'mentor' })), 'functions/permission-denied');
  await signInAs('sup', { role: 'super' });
  const { link } = await call('inviteManager', { email: 'o@m.co', role: 'owner', clubId: 'mentor' });
  assert.ok(link.startsWith('http'));
  const u = await aauth.getUserByEmail('o@m.co');
  assert.deepEqual(u.customClaims, { role: 'owner', club: 'mentor' });

  await signInAs(u.uid, u.customClaims);
  assert.equal(await code(call('inviteManager', { email: 'o2@m.co', role: 'owner', clubId: 'mentor' })), 'functions/permission-denied');
  assert.equal(await code(call('inviteManager', { email: 'b@m.co', role: 'branch', clubId: 'mentor', branchId: 'yafo' })), 'ok');
  assert.equal(await code(call('inviteManager', { email: 'b2@m.co', role: 'branch', clubId: 'other', branchId: 'yafo' })), 'functions/permission-denied');
  assert.equal(await code(call('inviteManager', { email: 'b3@m.co', role: 'branch', clubId: 'mentor', branchId: 'nope' })), 'functions/not-found');
});

test('login attempts are rate limited', async () => {
  await signOut(auth);
  let last;
  for (let i = 0; i < 12; i++) last = await code(call('tournamentLogin', { tId: 'sec', role: 'master', password: 'wrong' }));
  assert.equal(last, 'functions/resource-exhausted');
});
