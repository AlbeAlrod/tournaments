# Security model & hardening path

## How it works today
This app has **no Firebase Authentication**. Access control is done in the browser:
tournament `adminPassword` / `masterPassword` (stored as SHA-256 hashes in each
tournament doc) and a super-admin hash in `config/superAdmin`. Firestore itself is
**open read/write** to anyone who knows a document path.

`firestore.rules` in this repo codifies that model and adds two real protections:
- `config/*` is **read-only** from clients (the super-admin hash can't be overwritten).
- A catch-all **denies** writes to any collection other than the three the app uses.

Deploy the rules with:
```
firebase deploy --only firestore:rules
```
(needs the Firebase CLI logged into the `tournaments-33619` project).

## What is NOT protected (be honest with yourself before selling)
Because there is no server-side auth, the rules **cannot** stop a determined user:
- Anyone can read a tournament doc, which includes the **password hashes** (unsalted
  SHA-256 — brute-forceable offline) and every **registrant's name + phone number**.
- Anyone can open the browser console and call the write functions, or write to
  Firestore directly, to change scores, approve registrations, or delete data.

This is fine for a **private / low-stakes** event (you share the link with your own
crowd). It is **not** adequate for a product sold to untrusted customers.

## The real fix (a separate project)
1. Turn on **Firebase Auth** (Anonymous is enough to start).
2. Store per-tournament admin/master roles as **custom claims** set by a small
   **Cloud Function** that validates the password server-side (so the hash never
   leaves the server).
3. Rewrite `firestore.rules` to gate writes on `request.auth.token` roles, keep
   password hashes and phone numbers in an **admin-only subcollection** (`allow read:
   if isAdmin()`), and keep only non-PII fields publicly readable.

Until then, treat every tournament link as public-writable.
