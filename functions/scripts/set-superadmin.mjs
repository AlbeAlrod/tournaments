// One-off: give an existing Firebase Auth user the super-admin claim.
// Run locally with credentials for the tournaments-33619 project:
//   GOOGLE_APPLICATION_CREDENTIALS=key.json node functions/scripts/set-superadmin.mjs you@example.com
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const email = process.argv[2];
if (!email) { console.error('usage: node functions/scripts/set-superadmin.mjs <email>'); process.exit(1); }
initializeApp({ projectId: 'tournaments-33619' });
const user = await getAuth().getUserByEmail(email);
await getAuth().setCustomUserClaims(user.uid, { role: 'super' });
console.log(`super-admin claim set for ${email} (${user.uid}); sign out and in again to pick it up`);
