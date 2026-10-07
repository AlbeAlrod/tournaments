# LUZ tournaments — work plan & rules for parallel agents

Owner: Albe. Coordinator: the managing Claude session. Full review + roadmap lives in the
"LUZ — סקירה ותוכנית עבודה" doc.

## Order (security deliberately LAST, by owner's choice)
1. Bug fixes (non-security)
2. Hebrew/RTL, visual design, registration UX, logo upload, settings
3. Generic multi-sport engine (core/ + tests)
4. Super-admin, management, sharing/export, sales page
5. Security: Firebase Auth, orgs, licences server-side, PII, Storage, payments

Until phase 5 ships, do NOT add new security mechanisms and do NOT make existing ones weaker.
Never change firestore.rules in phases 1–4.

## Hard rules
- This app runs LIVE events. Every change must be backward compatible with existing
  Firestore documents (meta/categories/state shape). New fields are optional with defaults.
- Vanilla JS, ES modules, no build step yet. Firebase stays on 10.12.5 from gstatic.
- Only edit files your lane owns (below). Need a change elsewhere? Write it in your final
  report under "Requests for other lanes" — do not make it.
- No mass reformatting, no renaming of existing exported/window functions unless your task says so.
- Keep diffs focused. One logical change per commit. Commit message ends with:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Run `node --check <file>` on every JS file you touch. Pure logic gets `node --test` tests.
- The browser + Firebase CDN are NOT reachable in the sandbox, so UI cannot be run here.
  Read your code carefully, keep it simple, and list in your report exactly what the owner
  should click through to verify.

## Decisions already taken
- dn(): strip the Hebrew "ו" connector ONLY when the name contains no "/".
  Registered pairs are always "p1 / p2", so they are never touched.
- Language: Hebrew default with an EN toggle; per-tournament `meta.lang` ('he'|'en'), viewer
  choice stored in localStorage. `dir` follows the language.
- Logo/sponsor upload (pre-Auth): resize+compress in the browser to WebP/PNG, max 512px,
  target < 80KB, stored as a data URL in meta (Storage comes in phase 5). SVG rejected.
- Tests use the built-in `node --test` runner (no vitest), so no lane fights over devDeps.

## Lanes & file ownership
| Lane | Owns |
| --- | --- |
| A Infra | package.json, netlify.toml, .github/, ops/ (moved seed-*.html, fix-bracket.html), .eslintrc*, .editorconfig |
| C Core | core/**, tests/** |
| D Tournament app | app.js, index.html, uploader.js (new) |
| E Design & i18n | styles.css, i18n.js (new), fonts |
| F Admin & tools | admin.html, bracket.html, print-courts.html, king-of-court.html, ranking.html, validate.html |
| G League | league*.js, league.html, league.css, league-print.html |
| B Security (phase 5) | firestore.rules, storage.rules, functions/, common.js, SECURITY.md |

## Code style (owner's rule)
Minimal, to-the-point code. No code that wasn't asked for, no needless abstraction layers,
no comments stating the obvious. Prefer the standard library / platform APIs.
