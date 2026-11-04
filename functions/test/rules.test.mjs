import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, addDoc, collection } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-luz',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const anon = () => env.unauthenticatedContext().firestore();
const as = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
const owner = () => as('own', { role: 'owner', club: 'mentor' });
const branchMgr = b => as('br', { role: 'branch', club: 'mentor', branch: b });
const sup = () => as('sup', { role: 'super' });
const secureT = (extra = {}) => ({ secure: true, clubId: 'mentor', branchId: 'yafo', approval: 'pending', meta: { name: 'T' }, ...extra });
const seed = (path, data) => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), path), data));

test('legacy tournament: unchanged open model', async () => {
  await assertSucceeds(setDoc(doc(anon(), 'tournaments/old'), { meta: { name: 'x' } }));
  await assertSucceeds(updateDoc(doc(anon(), 'tournaments/old'), { 'meta.name': 'y' }));
  await assertSucceeds(addDoc(collection(anon(), 'tournaments/old/registrations'), { p1: 'a', p2: 'b', phone: '0501234567' }));
});

test('legacy tournament cannot be turned secure, and anon cannot create a secure one', async () => {
  await seed('tournaments/old', { meta: { name: 'x' } });
  await assertFails(updateDoc(doc(anon(), 'tournaments/old'), { secure: true }));
  await assertFails(setDoc(doc(anon(), 'tournaments/new'), secureT()));
});

test('secure create: club staff only, pending only, no passwords in meta', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'tournaments/a'), secureT()));
  await assertSucceeds(setDoc(doc(branchMgr('yafo'), 'tournaments/b'), secureT()));
  await assertFails(setDoc(doc(branchMgr('haifa'), 'tournaments/c'), secureT()));
  await assertFails(setDoc(doc(as('x', { role: 'owner', club: 'other' }), 'tournaments/d'), secureT()));
  await assertFails(setDoc(doc(owner(), 'tournaments/e'), secureT({ approval: 'approved' })));
  await assertFails(setDoc(doc(owner(), 'tournaments/f'), secureT({ meta: { adminPassword: 'h' } })));
  await assertSucceeds(setDoc(doc(sup(), 'tournaments/g'), secureT({ approval: 'approved' })));
});

test('secure update: managers only; approval by super only; club/branch fixed', async () => {
  await seed('tournaments/a', secureT());
  await assertFails(updateDoc(doc(anon(), 'tournaments/a'), { 'meta.name': 'hack' }));
  await assertSucceeds(updateDoc(doc(owner(), 'tournaments/a'), { 'meta.name': 'ok' }));
  await assertFails(updateDoc(doc(owner(), 'tournaments/a'), { approval: 'approved' }));
  await assertFails(updateDoc(doc(owner(), 'tournaments/a'), { branchId: 'haifa' }));
  await assertFails(updateDoc(doc(owner(), 'tournaments/a'), { secure: false }));
  await assertSucceeds(updateDoc(doc(sup(), 'tournaments/a'), { approval: 'approved' }));
});

test('tournament-password token manages only its own tournament', async () => {
  await seed('tournaments/a', secureT());
  await seed('tournaments/b', secureT());
  const t = as('t_a_admin', { tid: 'a', trole: 'admin' });
  await assertSucceeds(updateDoc(doc(t, 'tournaments/a'), { 'meta.name': 'ok' }));
  await assertFails(updateDoc(doc(t, 'tournaments/b'), { 'meta.name': 'no' }));
  await assertFails(setDoc(doc(as('t_a_admin', { tid: 'a', trole: 'admin', club: 'mentor', role: 'owner' }), 'tournaments/c'), secureT()));
});

test('secure registrations: no client create; managers edit allowed fields only', async () => {
  await seed('tournaments/a', secureT());
  await seed('tournaments/a/registrations/r1', { p1: 'a', p2: 'b', category: 'c1', status: 'pending', paid: false });
  await assertFails(addDoc(collection(anon(), 'tournaments/a/registrations'), { p1: 'a', p2: 'b' }));
  await assertFails(addDoc(collection(owner(), 'tournaments/a/registrations'), { p1: 'a', p2: 'b' }));
  await assertFails(updateDoc(doc(anon(), 'tournaments/a/registrations/r1'), { paid: true }));
  await assertSucceeds(updateDoc(doc(owner(), 'tournaments/a/registrations/r1'), { status: 'approved', paid: true }));
  await assertFails(updateDoc(doc(owner(), 'tournaments/a/registrations/r1'), { phone: '0501234567' }));
  await assertSucceeds(getDoc(doc(anon(), 'tournaments/a/registrations/r1')));
});

test('contact details and secrets are not public', async () => {
  await seed('tournaments/a', secureT());
  await seed('tournaments/a/registrations/r1/private/contact', { phone: '0501234567', email: 'a@b.co' });
  await seed('tournaments/a/private/secrets', { admin: 'salt:hash' });
  await assertFails(getDoc(doc(anon(), 'tournaments/a/registrations/r1/private/contact')));
  await assertFails(getDoc(doc(branchMgr('haifa'), 'tournaments/a/registrations/r1/private/contact')));
  await assertSucceeds(getDoc(doc(owner(), 'tournaments/a/registrations/r1/private/contact')));
  await assertFails(getDoc(doc(owner(), 'tournaments/a/private/secrets')));
  await assertFails(getDoc(doc(sup(), 'tournaments/a/private/secrets')));
});

test('clubs, branches, users', async () => {
  await assertFails(setDoc(doc(owner(), 'clubs/mentor'), { name: 'M' }));
  await assertSucceeds(setDoc(doc(sup(), 'clubs/mentor'), { name: 'M' }));
  await assertSucceeds(setDoc(doc(owner(), 'clubs/mentor/branches/yafo'), { name: 'יפו' }));
  await assertFails(setDoc(doc(branchMgr('yafo'), 'clubs/mentor/branches/haifa'), { name: 'חיפה' }));
  await seed('users/own', { role: 'owner' });
  await assertSucceeds(getDoc(doc(owner(), 'users/own')));
  await assertFails(getDoc(doc(anon(), 'users/own')));
  await assertFails(setDoc(doc(owner(), 'users/own'), { role: 'super' }));
  await assertFails(getDoc(doc(anon(), 'rateLimits/x')));
});
