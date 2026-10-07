# ops/ — manual one-off tools

The HTML pages in this folder are **one-off client-side scripts** that were used to seed
or repair specific tournaments in Firestore by hand:

| File | Purpose |
| --- | --- |
| `seed-fridaydinner.html` | Seed the "Friday dinner" tournament |
| `seed-futilina.html` | Seed the Futilina tournament |
| `seed-futsilina.html` | Seed the Futsilina tournament |
| `seed-futsilina-queen.html` | Seed the Futsilina queen tournament |
| `seed-volleylab5.html` | Seed the Volleylab 5 tournament |
| `fix-bracket.html` | One-time repair of a bracket document |

## Rules

- **Never deploy these.** `netlify.toml` forces `/ops/*` to return 404, but treat that as a
  safety net only — never link to these pages from the app.
- They write directly to the production Firestore project. Run them only locally, on purpose,
  and only after reading the code.
- **Several of them contain hard-coded passwords** (tournament admin / level passwords).
  Those passwords have been public in the repository history and **must be rotated** on the
  affected tournaments. Do not reuse them, and do not copy them into docs, issues or chat.
- New seed/repair tools belong here too, and must not contain secrets — prompt for them at
  runtime instead.

`check-syntax.mjs` and `run-tests.mjs` in this folder are dev scripts used by `npm run check`
and `npm test`; they are not part of the site either.
