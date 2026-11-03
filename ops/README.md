# ops/ — manual one-off tools

The one-off seed/repair HTML pages that used to live here were removed in wave 3: they held
plain-text passwords and wrote straight to production docs, and GitHub Pages would have served
them. They remain in git history (before `luz-wave3`) if ever needed — run them locally only.

## Rules

- Never add HTML tools here again: GitHub Pages serves everything in the branch.
- The `.mjs` scripts write directly to the production Firestore project. Run them only locally,
  on purpose, and only after reading the code.
- **The removed pages contained hard-coded passwords** (tournament admin / level passwords).
  Those passwords have been public in the repository history and **must be rotated** on the
  affected tournaments. Do not reuse them, and do not copy them into docs, issues or chat.
- New seed/repair tools must be `.mjs` scripts and must not contain secrets — prompt for them at
  runtime instead.

## Print to PDF without the browser dialog

When printing fails (in-app browsers can't print), make the PDFs with headless Chrome. The pages
set `window.__READY__` after data and fonts load; `--virtual-time-budget` waits for that.

```sh
T=<tournament-id>; U=https://albealrod.github.io/tournaments
google-chrome --headless=new --virtual-time-budget=15000 --no-pdf-header-footer --print-to-pdf=courts.pdf "$U/print-courts.html?t=$T"
google-chrome --headless=new --virtual-time-budget=15000 --no-pdf-header-footer --print-to-pdf=bracket.pdf "$U/bracket.html?t=$T"
```

`check-syntax.mjs` and `run-tests.mjs` in this folder are dev scripts used by `npm run check`
and `npm test`; they are not part of the site either.
