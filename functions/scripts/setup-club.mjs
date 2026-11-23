// One-off: create or update a club, its brand and its branches from a JSON file.
// Run locally with credentials for the tournaments-33619 project:
//   node functions/scripts/setup-club.mjs functions/scripts/clubs/mentor.json
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const file = process.argv[2];
if (!file) { console.error('usage: node functions/scripts/setup-club.mjs <club.json>'); process.exit(1); }
const { id, name, brand, branches = [] } = JSON.parse(readFileSync(file, 'utf8'));
initializeApp({ projectId: 'tournaments-33619' });
const db = getFirestore(), batch = db.batch();
batch.set(db.doc(`clubs/${id}`), { name, brand, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
for (const b of branches) batch.set(db.doc(`clubs/${id}/branches/${b.id}`), { name: b.name, place: b.place || '' }, { merge: true });
await batch.commit();
console.log(`club ${id} (${name}) with ${branches.length} branches is ready`);
