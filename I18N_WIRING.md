# Wiring i18n.js into the tournament app (for Lane D)

`i18n.js` and the RTL-ready `styles.css` are in place (Lane E). Nothing calls
them yet. This guide lists every change `index.html` / `app.js` need. Line
numbers are from base commit **19ccb6e**. If your branch has moved, search for
the quoted English string instead.

Keys are written as `prefix.name`. Every key named here exists in both `he`
and `en` (checked by the script in §9).

---

## 0. Ground rules

1. **Translate at render time only.** Never translate a value that is written
   to Firestore or compared in logic. These stay exactly as they are, in English:
   - KO slot strings: `'TBD'`, `'BYE'`, `'Loser of SF1'`, `'Loser of SF2'`,
     `` `Winner of ${prevName} ${n}` `` (lines 1041, 1051, 1383, 1408–1409, 1455,
     1734, 1801–1802, 1811–1812). `getKOWinner`, `isSeed` and `isSeed3`
     (2056, 2149) test them with `startsWith('Winner')` / `startsWith('Loser')`.
   - `roundName()` / `getKORoundName()` (1242–1260). Their output goes into
     the stored `Winner of …` strings (1404, 1787). Keep them in English and add
     a separate display helper (§4.6).
   - Registration `status` values, `meta.phase`, category ids.
   - The default category name `'New Category'` (2810) is user data once
     created. Seed it with `t('settings.newCategory')` (it is stored in the
     language the master is using, which is fine).
2. **User content is never translated**: pair names, category names, group
   names, notes, sponsor names, `meta.dinnerBreakNote`.
3. `_focusSnapshot()` (2895) builds a selector from the input's `placeholder`.
   That still works, because placeholders do not change between two renders in the
   same language. On `langchange`, focus is not restored, which is acceptable.

---

## 1. Boot: `initLang` with `meta.lang`

`app.js` top:

```js
import { t, initLang, setLang, getLang, applyStatic, fmtDate, tRound, tSlot } from './i18n.js?v=1';
```

`meta` defaults (line 23): add `lang: 'he'` (optional field, default Hebrew,
so existing documents are unaffected).

Boot (`window.addEventListener('load', …)`, line 3076):

```js
initLang();                 // before loadTournament: loading/expired/none screens get the saved choice or Hebrew
applyStatic();
const ok = await loadTournament();
if (!ok) return;
initLang(meta.lang);        // now the tournament's default applies (a saved viewer choice still wins)
applyStatic();
…
renderAll();
```

`initLang` sets `<html lang dir>`. In `index.html` line 2, change to
`<html lang="he" dir="rtl">` so the first paint before JS runs is already
right.

Language change:

```js
window.addEventListener('langchange', () => { applyStatic(); renderAll(); refreshAdmin(); });
window.setLang = setLang;   // for the header toggle's onclick
```

Optional master setting (Settings → Design): a select bound to
`updateMeta('lang', v)` that sets the tournament default. No new key is needed
beyond `lang.aria`. Label it `t('lang.aria')`.

---

## 2. Language toggle in the header (עב | EN)

`index.html`, inside `<header>` after `.logo` (line 55):

```html
<div class="langsw" role="group" data-i18n-aria="lang.aria">
  <button type="button" class="langsw__b" data-lang="he" onclick="setLang('he')" lang="he">עב</button>
  <button type="button" class="langsw__b" data-lang="en" onclick="setLang('en')" lang="en">EN</button>
</div>
```

In `renderAllInner()` mark the active one:
`document.querySelectorAll('.langsw__b').forEach(b => b.classList.toggle('is-on', b.dataset.lang === getLang()));`
and set `aria-pressed` the same way.

`.langsw` / `.langsw__b` / `.is-on` are styled in styles.css (league.css
overrides them with its own look on league pages).

---

## 3. index.html — static strings → `data-i18n*`

| Line | Element | Attribute to add |
| --- | --- | --- |
| 16 | `<h1>Tournament Expired` | `data-i18n="common.expiredH"` |
| 17 | `<p>This tournament page…` | `data-i18n="common.expiredP"` |
| 24 | `<h1>Tournaments` | `data-i18n="common.noTournamentH"` |
| 25 | `<p>No tournament specified…` | `data-i18n-html="common.noTournamentP"` |
| 31 | `<p>Loading…` | `data-i18n="common.loading"` |
| 41 | `#mode-text` | `data-i18n="admin.modeHint"` (refreshAdmin overwrites it, see §4.1) |
| 44 | `#adm-txt` | `data-i18n="admin.btn"` |
| 54 | `#header-name` | none (meta.name). Fallback text: `t('common.tournament')` |
| 57 | `<nav id="main-nav">` | `data-i18n-aria="common.nav.aria"` |
| 59 | `#tab-register` | `data-i18n="common.nav.register"` |
| 60 | `#tab-participants` | `data-i18n="common.nav.participants"` |
| 61 | `#tab-registrations` | `data-i18n="common.nav.registrations"` |
| 62 | `#tab-build` | `data-i18n="common.nav.build"` |
| 64 | `#tab-standings` | `data-i18n="common.nav.standings"` |
| 65 | `#tab-schedule` | `data-i18n="common.nav.schedule"` |
| 66 | `#tab-bracket` | `data-i18n="common.nav.bracket"` |
| 68 | `#tab-settings` | `data-i18n="common.nav.settings"` |
| 78 | `#reg-title` | `data-i18n="reg.title"` |
| 81 | `#reg-closed-msg` | `data-i18n="reg.closed"` |
| 85 | label Player 1 | `data-i18n="reg.p1Label"`, add `for="frm-p1"` |
| 86 | `#frm-p1` | `data-i18n-ph="reg.namePh"`, `dir="auto"`, `autocomplete="name"` |
| 89 | label Player 2 | `data-i18n="reg.p2Label"`, add `for="frm-p2"` |
| 90 | `#frm-p2` | `data-i18n-ph="reg.namePh"`, `dir="auto"` |
| 93 | label Phone | `data-i18n="reg.phoneLabel"`, add `for="frm-phone"` |
| 94 | `#frm-phone` | `dir="ltr"`, `inputmode="tel"` (placeholder is a number, keep it) |
| 97 | label Category | `data-i18n="reg.catLabel"` |
| 101 | `#frm-ok` | `data-i18n="reg.ok"` |
| 102 | submit button | `data-i18n="reg.submit"` |
| 112 | `<h2>Registered Participants` | `data-i18n="parts.title"` |
| 113 | `#participants-subtitle` | `data-i18n="parts.subtitle"` |
| 115 | `#participants-hidden-msg` | `data-i18n="parts.hidden"` |
| 122 | `<h2>Registrations` | `data-i18n="admin.regsTitle"` |
| 124 | `#rf-all` | `data-i18n="admin.filterAll"` |
| 125 | `#rf-pending` | `data-i18n="admin.filterPending"` |
| 126 | `#rf-approved` | `data-i18n="admin.filterApproved"` |
| 127 | `#rf-rejected` | `data-i18n="admin.filterRejected"` |
| 136 | `<h2>Build Tournament` | `data-i18n="build.title"` |
| 137 | `<p>Drag pairs into order…` | `data-i18n="build.subtitle"` |
| 145 | `<h2>Standings` | `data-i18n="stand.title"` |
| 153 | `#sched-search` | `data-i18n-ph="sched.searchPh"`, `data-i18n-aria="sched.searchAria"`, `type="search"`, `dir="auto"` |
| 164 | `<h2>Knockout Bracket` | `data-i18n="bracket.title"` |
| 170 | `<h2>Settings` | `data-i18n="settings.title"` |
| 180 | `<h3>Login` | `data-i18n="admin.loginTitle"` |
| 182 | `#role-btn-admin` | `data-i18n="admin.roleAdmin"` |
| 183 | `#role-btn-master` | `data-i18n="admin.roleMaster"` |
| 186 | `#pw-inp` | `data-i18n-ph="admin.pwPh"`, `dir="ltr"`, `autocomplete="current-password"` |
| 189 | `#pw-err` | `data-i18n="admin.pwWrong"`; drop inline `color:#DC2626` → `class="frm-err h"` |
| 191 | Login button | `data-i18n="admin.loginBtn"` |
| 192, 207, 227, 250 | Cancel buttons | `data-i18n="common.cancel"` |
| 200 | `<h3>Start Tournament?` | `data-i18n="build.startQ"` |
| 201–204 | `<p>Are you sure…` | `data-i18n="build.startBody"` |
| 206 | Confirm | `data-i18n="common.confirm"` |
| 215 | `#edit-modal-title` | `data-i18n="build.editPair"` |
| 217, 240 | `#edit-p1`, `#ap-p1` | `data-i18n-ph="common.player1"`, `dir="auto"` |
| 220, 243 | `#edit-p2`, `#ap-p2` | `data-i18n-ph="common.player2"`, `dir="auto"` |
| 226 | Save | `data-i18n="common.save"` |
| 238 | `<h3>Add Pair Directly` | `data-i18n="build.addPairTitle"` |
| 249 | Add | `data-i18n="common.add"` |

Also: drop `maximum-scale=1,user-scalable=no` from the viewport meta (line 5).
Every input is now ≥ 16px, so iOS no longer zooms on focus, and blocking zoom
fails accessibility. Bump `styles.css?v=` and add the Rubik `400;500;700;800` weights only (600/900 are no longer used).

---

## 4. app.js — every template string

`dnH(x)` output is user content. Wherever it is printed, wrap it as
`<bdi dir="auto">${dnH(x)}</bdi>` **unless** the parent already has one of the
name classes (`.gt .bname .part-name .reg-name .build-name .grp-team-name
.player-db-name .champ-name .bteam`), which get `unicode-bidi: plaintext` from
styles.css. The simplest consistent rule is to change `dnH` itself:

```js
const dnH = s => `<bdi dir="auto">${escH(dn(s))}</bdi>`;
```

At 19ccb6e no call site puts `dnH` into an attribute or a `confirm()`/`alert()`;
if you add one, use `escH(dn(s))` (attribute) or `dn(s)` (dialog) there.

Numbers, scores, times: wrap in `<span class="num">…</span>` (LTR-isolated,
tabular). Marked **[num]** below.

### 4.1 Admin bar / login (refreshAdmin, updateRoleButtons)

| Line | Now | Becomes |
| --- | --- | --- |
| 424–427 | inline `style` with `'Barlow Condensed'` (font not loaded) | Drop the inline styles; toggle a class instead: `el.classList.toggle('on', loginRole===role)` and `el.setAttribute('aria-pressed', …)`. styles.css styles `#role-btn-admin.on` / `#role-btn-master.on` |
| 478 | `'Master ✓' / 'Admin ✓' / 'Admin'` | `t('admin.btnMasterOn')` / `t('admin.btnAdminOn')` / `t('admin.btn')` |
| 486 | `'View only — tap Admin to manage'` | `t('admin.modeView')` |
| 487 | `'Master mode — full access'` / `'Admin mode — approvals & add players'` | `t('admin.modeMasterReg')` / `t('admin.modeAdminReg')` |
| 488 | `'Master mode — tournament built'` / `'Admin mode — edit roster'` | `t('admin.modeMasterBuilt')` / `t('admin.modeAdminBuilt')` |
| 489 | `'Admin mode — score entry'` | `t('admin.modeScores')` |

### 4.2 Registration

| Line | Now | Becomes |
| --- | --- | --- |
| 540 | `'Player 1 name is required.'` | `t('errors.p1Required')` |
| 541 | `'Please select a category.'` | `t('errors.catRequired')` |
| 555 | `'Submission failed. Please try again.'` | `t('errors.submitFailed')` |
| 564 | `confirm('Reject and permanently remove…')` | `confirm(t('admin.confirmDelete'))` |
| 597 | `alert('Error updating status')` | `alert(t('errors.statusUpdate'))` |
| 629 | `<h3>No registrations</h3>` | `t('admin.noRegs')` |
| 637 | `.reg-name` | already a name class; with the new `dnH`, use `${dnH(r.p1)}${r.p2 ? ' / ' + dnH(r.p2) : ''}` (it uses `escH` today) |
| 638 | `new Date(r.createdAt?.seconds*1000\|\|0).toLocaleDateString()` | `fmtDate(r.createdAt)` **[num]** (returns `''` instead of 1/1/1970 for pending timestamps) |
| 639 | `escH(r.phone\|\|'—')` | `<span class="num">${escH(r.phone\|\|t('admin.noPhone'))}</span>` (`.reg-phone` is already LTR) |
| 641 | `${r.status}` | `${t('admin.status.' + r.status)}` |
| 643 | `Approve` | `t('admin.approve')` |
| 644 | `Undo` | `t('admin.undo')` |
| 645 | `title="Permanently remove">Delete` | `title="${t('admin.deleteTitle')}">${t('admin.delete')}` |
| 663 | `No approved participants yet` | `t('parts.empty')` |
| 680 | `.part-name` | name class, fine as is; `.part-num` **[num]** |
| 691 | `'Payment Link'` | `t('reg.payLink')` |
| 692 | `'Payment Link 2'` | `t('reg.payLink2')` |
| 699 | `Payment` | `t('reg.payment')` |
| 716 | `` `Register for ${meta.name}` `` | `t('reg.subtitle', {name: meta.name})`. **Use `textContent`** (it is): no escaping concern |

### 4.3 Build page

| Line | Now | Becomes |
| --- | --- | --- |
| 747 | inline banner style | replace with `banner.className = 'frm-ok'` (same look, theme-aware) |
| 748 | `'✓ הטורניר בנוי — ניתן עדיין…'` | `t('build.builtBanner')` |
| 773 | `` `${roster.length} pairs` `` | `t('build.pairsCount', {n: roster.length})` |
| 780 | `'↺ Rebuild'` / `'▶ Build Tournament'` | `t('build.rebuild')` / `t('build.build')`. Wrap the glyph: the ▶ must point inline-end → `<span class="flip-rtl">▶</span>` + text (keys contain the glyph today; split if you do this) |
| 781 | `Shuffle` | `t('build.shuffle')` |
| 782 | `+ Add Pair` | `t('build.addPair')` |
| 790 | inline `startWrap` style | fine to keep |
| 792 | `'הטורניר בנוי ומוכן. לחצי Start…'` (feminine) | `t('build.startNoteBuilt')` (contains `<br>`, so it is used in innerHTML: OK, dictionary string) |
| 793 | `'בני תחילה … הפעילי …'` (feminine) | `t('build.startNoteReg')` |
| 796 | `▶ Start Tournament`; inline `style="opacity:.45…"` | `t('build.start')`; drop the inline style. `.gen-btn:disabled` now exists in styles.css |
| 806 | `title="Edit">Edit` | `title="${t('common.edit')}">${t('common.edit')}` |
| 807 | `title="Up">↑` | `title="${t('build.moveUp')}" aria-label="${t('build.moveUp')}">↑` (vertical, no flip) |
| 808 | `title="Down">↓` | `t('build.moveDown')` likewise |
| 809 | `title="Remove">✕` | `title="${t('common.remove')}" aria-label="${t('common.remove')}"` |
| 820 | `'Edit Pair'` | `t('build.editPair')` |
| 835 | `` `Remove "${name}" from the tournament?` `` / `'Remove this pair?'` | `t('build.confirmRemove', {name})` / `t('build.confirmRemoveAnon')` |
| 1160 | `alert('No approved pairs in this category.')` | `alert(t('errors.noApproved'))` |

### 4.4 Score errors (scoreError, 1480–1500)

Return keys + vars rather than English, so core/scoring.js (Lane C) can
return the same shape later: `{ key, vars }`, rendered as `t(e.key, e.vars)`.

| Line | Now | Key |
| --- | --- | --- |
| 1484 | `'Scores must be 0 or higher'` | `score.nonNegative` |
| 1489 | `'Sets won: 2:0 or 2:1'` | `score.setsFormat` |
| 1490 | `'Winner must have 2 sets'` | `score.setsWinner` |
| 1495 | `` `Scores can't be equal` `` | `score.noDraw` |
| 1496 | `` `Must reach ${ptw} · e.g. ${ptw}–${lo}` `` | `score.mustReachEg` `{n: ptw, lo}` (or `score.mustReach` `{n}`) |
| 1497 | `` `Need 2-point lead` `` | `score.needLead` `{n: 2}` |
| 1498 | `` `Above ${ptw}: exactly 2 apart` `` | `score.exactlyTwoAbove` `{n: ptw}` |

Callers: `setGS` 1715, `setKS` 1726: `errEl.textContent = err ? t(err.key, err.vars) : ''`.

### 4.5 Standings

| Line | Now | Becomes |
| --- | --- | --- |
| 1564 | `✎` button | add `title`/`aria-label` = `t('stand.editAria')` |
| 1565 | `✕` button | `t('stand.removeAria')` |
| 1567 | `<span class="rnk">#${i+1}</span>${dnH(t.name)}` | `.rnk` **[num]**; name via new `dnH` |
| 1568–1570 | `t.w`, `t.l`, `diffStr`, `t.pts` | **[num]** on diffStr (keeps `+3` / `−2` sign on the correct side) |
| 1575 | `` `Group ${escH(grp.name)}` `` | `t('stand.group', {name: escH(grp.name)})` |
| 1576 | `<th>Team</th><th>W</th><th>L</th><th>+/−</th><th>Pts</th>` | `stand.col.team`, `stand.col.w`, `stand.col.l`, `stand.col.diff`, `stand.col.pts` |
| 1603 | `No tournament data yet` / `Build the tournament first.` | `t('stand.emptyH')` / `t('common.buildFirst')` |
| 1624 | `` `Edit — Group ${…name}` `` | `t('stand.editTitle', {name})` (textContent) |
| 1692 | `alert('Group needs at least 1 team')` | `t('errors.groupMin')` |
| 1693 | `` `Remove "${…}" from group ${grp.name}?` `` | `t('stand.confirmRemove', {name, group: grp.name})` |

**Note on the variable name `t`.** app.js already uses `t` as a local name
in many places: `makeStandingsCard` (`st.map((t,i) => …)`, 1555, which is
exactly where the column headers get translated), `getStandings` (1513,
1532), the coordinated scheduler (1069–1118), and the `t2m(t)`/`addM(t, m)`
parameters (1198, 1200). Inside those scopes `t(...)` would call a string.
Import as `import { t as tr, … }`, **or** rename the locals in 1555 (to `row`)
and in any function where you add a `t()` call. Grep: `grep -nE "\bt ?=>|\(t[,)]" app.js`.

### 4.6 Schedule

| Line | Now | Becomes |
| --- | --- | --- |
| 1854 | `Pool games played` + `${donePool}/${totalPool}` | `t('sched.statPool')`; value **[num]** (`.sv` already LTR) |
| 1855 | `Knockout games` | `t('sched.statKO')` |
| 1856 | `Scheduled end` | `t('sched.statEnd')` |
| 1869 | `koGameLabel()` (1817–1829) returns `'Final'`, `` `SF${n}` ``, `` `QF${n}` ``, `` `R16-${n}` ``, `` `G${n}` `` | display only, so translate inside it: `bracket.lbl.final`, `bracket.lbl.sf`, `bracket.lbl.qf`, `bracket.lbl.r16`, `bracket.lbl.game` with `{n}` |
| 1872, 1875 | score inputs | add `aria-label="${t('sched.scoreA')}"` / `t('sched.scoreB')`; keep `type="number" inputmode="numeric"` |
| 1877 | `` `${g.sa} : ${g.sb}` `` / `'— : —'` | unchanged. `.sw` is forced LTR in CSS, so A : B keeps its order in RTL |
| 1880 | `` `C${g.court}` `` | `t('sched.courtShort', {n: g.court})` |
| 1882 | `.gt` + `.gtag` group | name class; `.gtag` content is user data |
| 1883 | `vs` | `t('sched.vs')` |
| 1900 | `No schedule yet` / `Build the tournament first.` | `t('sched.emptyH')` / `t('common.buildFirst')` |
| 1913 | `No games` | `t('sched.noGames')` |
| 1921 | `` `No match for "${escH(q)}"` `` | `t('sched.noMatch', {q: escH(q)})` |
| 1929 | `'הפסקה'` | `t('sched.breakDefault')` |
| 1934–1936 | dinner marker, inline styles; Hebrew line `${note} — הפסקה ${min} דק׳ · ${from}–${to} · כל המגרשים` | `t('sched.breakLine', {note: escH(dinnerNote), min: b.min, from: m2t(b.at), to: m2t(b.at+b.min)})`. Wrap `from`/`to` in `<span class="num">` first, then pass them in |
| 1948 | `` `${catName} — ${g._rn}` `` | `_rn` is English from `getKORoundName`. Display `tRound(fromEnd)` instead: compute `fromEnd = cs.ko.length-1-ri` and use `t('sched.subLabel', {cat: catName, stage: tRound(fromEnd)})` (keep `key` using the English `_rn`) |
| 1949 | `` `${catName} — 3/4` `` / `'3/4'` | `t('sched.subLabel', {cat, stage: t('sched.third')})` / `t('sched.third')` |
| 1950 | `` `${catName} — Pools` `` / `'Pools'` | `t('sched.subLabel', {cat, stage: t('sched.pools')})` / `t('sched.pools')` |
| 1962 | `` ` (to ${r.pts} switch ${r.change})` `` / `` ` (to ${r.pts})` `` | `t('sched.ruleSwitch', {pts: r.pts, change: r.change})` / `t('sched.rule', {pts: r.pts})` |
| 1990 | `>All<` | `t('common.all')` |
| 1992 | `` `Court ${c}` `` | `t('sched.court', {n: c})` |
| 1955 | `.tlbl` time | already LTR-isolated in CSS |

### 4.7 Bracket

| Line | Now | Becomes |
| --- | --- | --- |
| 2013 | `'No pool stage scheduled yet.'` | `t('bracket.noPool')` |
| 2014 | `` `Pool: <span>${done}/${total} played</span> — bracket updates live` `` | `t('bracket.poolInfo', {progress: '<span class="num">' + t('bracket.poolPlayed', {done, total}) + '</span>'})` |
| 2036, 2052, 2061, 2150 | labels from stored slots (`'TBD'`, `Winner of …`, `Loser of SF1`) | wrap the raw value with `tSlot()` **before** `dnH`: `dnH(tSlot(x))`. `tSlot` passes real pair names through unchanged |
| 2040 | `Direct ↗` | `t('bracket.direct')` + `<span class="flip-rtl">↗</span>` |
| 2086 | `${getKORoundName(catId,0)} <span class="brnd-arrow">→</span> ${…1}` | `tRound(len-1-0)` / `tRound(len-1-1)`; the arrow already flips in CSS (`[dir=rtl] .brnd-arrow`) |
| 2096 | `arr.textContent='→'` (`.hlane-arrow`) | unchanged, flips in CSS |
| 2108 | `${getKORoundName(catId,ri)}` | `tRound(cs.ko.length-1-ri)` |
| 2153 | `div3.style.cssText='border-top:1px solid rgba(255,255,255,0.15)…'` | white line on a white page. Change to `var(--border)` |
| 2155 | `3rd Place` | `t('bracket.third')` |
| 2173 | `CHAMPION` | `t('bracket.champion')` (CSS uppercases it in English; `:lang(he)` turns that off) |
| 2198 | connector stroke `rgba(255,255,255,0.25)` | invisible on white; styles.css now overrides it with `stroke: var(--border2)`. Optional: set the attribute to `currentColor` |

### 4.8 Category filter

| Line | Now | Becomes |
| --- | --- | --- |
| 2294 | `>All<` | `t('common.all')` |

### 4.9 Settings

| Line | Now | Key |
| --- | --- | --- |
| 2311 | `Design` | `settings.design` |
| 2313 | `Tournament Name` | `settings.name` |
| 2316 | `placeholder="Tournament name"` | `settings.namePh`; add `dir="auto"` |
| 2321 / 2322 | `Primary Color` / `Main accent — headers, buttons` | `settings.primary` / `settings.primaryDesc` |
| 2333 / 2334 | `Secondary Color` / `Gradient & accent buttons` | `settings.secondary` / `settings.secondaryDesc` |
| 2344 | `Preview` | `settings.preview` |
| 2346 | `'Barlow Condensed'` inline font | replace with `inherit` (font is not loaded) |
| 2351 / 2352 | `Background Color` / `Site background override` | `settings.bg` / `settings.bgDesc` |
| 2359, 2398 | `Reset` | `common.reset` (drop the inline `font-size:11px`) |
| 2368 | `Logo` | `settings.logo` |
| 2371 / 2372 | `Logo URL` / `Tournament logo image` | `settings.logoUrl` / `settings.logoDesc`; input `type="url" dir="ltr"` |
| 2387 | `Group Colors` | `settings.groupColors` |
| 2391 | `` `Group ${n}` `` | `t('stand.group', {name: n})` |
| 2409 | `Sponsors` | `settings.sponsors` |
| 2417 | `placeholder="Image URL…"` | `settings.sponsorUrlPh` (+ `dir="ltr"`) |
| 2419 | `placeholder="Name…"` | `settings.sponsorNamePh` (+ `dir="auto"`) |
| 2420 | `title="Remove"` | `common.remove` |
| 2422 | `No sponsors yet — add one below.` | `settings.noSponsors` |
| 2425 | `+ Add Sponsor` | `settings.addSponsor` |
| 3004 | `Players Database` | `settings.players` |
| 3006 | `placeholder="Player name…"` | `settings.playerNamePh` (+ `dir="auto"`) |
| 3007 | `placeholder="Phone (optional)"` | `settings.playerPhonePh` (+ `type="tel" dir="ltr"`) |
| 3008 | `+ Add` | `common.addPlus` |
| 3012 | `↓ Import all players from this tournament` | `settings.importPlayers` |
| 3014 | `` `${playerDB.length} players` `` | `t('settings.playersCount', {n})`; drop inline `margin-left` → `margin-inline-start` |
| 3023 | `No players yet — click Import…` | `settings.noPlayers` |
| 3050 | `` alert(`Imported ${added} new players.`) `` | `t('settings.imported', {n: added})` |
| 3052 | `'All players are already in the database.'` | `settings.allImported` |
| 2445 | `Group` span (inline uppercase + letter-spacing) | `settings.groupLabel`; remove `text-transform`/`letter-spacing` inline |
| 2448 | `` `${grp.teams.length} teams` `` + inline `margin-left:4px` | `t('settings.teamsCount', {n})`; `margin-inline-start` |
| 2453 | `.grp-team-name` → `escH(team)` | use `dnH(team)` for consistency |
| 2456 | `Move to…` | `settings.moveTo` |
| 2457 | `` `→ ${escH(tg.name)}` `` | `t('settings.moveToGroup', {name: escH(tg.name)})` (drop the arrow) |
| 2464 | `Groups` | `settings.groups` |
| 2473, 2475 | `Sport` | `settings.sport` |
| 2476 | sport description | `settings.sportDesc` |
| 2479 | `Footvolley / custom` | `settings.sportFootvolley` |
| 2480 | `Volleyball (עד 21)` | `settings.sportVolleyball` |
| 2489 | `Registration` | `settings.registration` |
| 2491 | `Registration Open` | `settings.regOpen` |
| 2495 | `Show Participant List (public)` | `settings.showList` |
| 2500 / 2501 | `Registration Note` / `Shown below the registration form.` | `settings.regNote` / `settings.regNoteDesc` |
| 2506 | `placeholder="e.g. Payment deadline is Friday…"` | `settings.regNotePh`; textarea `dir="auto"` |
| 2511 / 2512 | `Payment Links` / `Shown in the registration form.` | `settings.payLinks` / `settings.payLinksDesc` |
| 2516, 2522 | `placeholder="Label…"` | `settings.labelPh` (+ `dir="auto"`) |
| 2518 | `placeholder="https://…"` | keep; add `type="url" dir="ltr"` |
| 2524 | `placeholder="https://… (optional)"` | `settings.urlOptionalPh` (+ `type="url"`) |
| 2534 | `Categories` | `settings.categories` |
| 2538 / 2539 | `Add Category` / `Create a new category…` | `settings.addCategory` / `settings.addCategoryDesc` |
| 2541 | `+ Add` | `common.addPlus` |
| 2550 | `Start Tournament` | `settings.start` |
| 2551–2554 | `When all pairs are ready…<br>Pairs and settings…` | `settings.startNote` (innerHTML, has `<br>`) |
| 2555 | `▶ Start Tournament` | `build.start` |
| 2655 | inline `margin-left:auto;margin-right:8px` | `margin-inline-start:auto;margin-inline-end:8px` |
| 2661 | `title="Delete"` | `settings.deleteCategory` |
| 2664 | `catNumField('Courts', …)` | `t('settings.courts')` |
| 2665 | `'Groups'` | `settings.numGroups` |
| 2666 | `'Adv/Group'` | `settings.advPerGroup` |
| 2667 | `'Game min'` | `settings.gameDur` |
| 2668 | `'Break min'` | `settings.breakDur` |
| 2670 | `Sets` | `settings.sets` |
| 2672 | `select … style="…font-size:13px"` | remove the inline font-size (iOS zoom; CSS sets 16px) |
| 2678 | `'3rd set pts'` | `settings.thirdSetPts` |
| 2680 | `Start Time` | `settings.startTime` |
| 2687 | `SCORING RULES` (inline uppercase, 10px, letter-spacing 2px) | `settings.scoringRules`; remove the inline style |
| 2689 | `<th>Stage</th><th>Pts to win</th><th>Switch @</th><th>Min</th>` | `settings.rules.stage`, `settings.rules.pts`, `settings.rules.switch`, `settings.rules.min` |
| 2692 | `'Pool'` | `settings.stage.pool` |
| 2693 | `'R16 (שמינית)'` | `settings.stage.r16` |
| 2694 | `'QF (רבע)'` | `settings.stage.qf` |
| 2695 | `'SF (חצי)'` | `settings.stage.sf` |
| 2696 | `'3/4'` | `settings.stage.third` |
| 2697 | `'Final (גמר)'` | `settings.stage.final` |
| 2743, 2921 | `document.title = …'Tournaments'` | `t('common.appName')` |
| 2810 | `name:'New Category'` | `t('settings.newCategory')` |
| 2815 | `alert('Cannot delete categories…')` | `settings.cantDeleteCat` |
| 2816 | `confirm('Delete this category?')` | `settings.confirmDeleteCat` |
| 2824 | `confirm('Reset ALL scores?')` | `settings.confirmResetScores` |
| 2920 | `meta.name\|\|'Tournament'` | `meta.name \|\| t('common.tournament')` |

Inputs that hold names (`#new-player-name`, category name input 2654, group
name input 2446): add `dir="auto"`. Hex inputs (`.text-mono`) are LTR via CSS.
Several settings inputs carry `style="…font-size:…"`. styles.css forces
16px on phones with `!important`, but please drop the inline sizes anyway.

---

## 5. Inline physical styles to convert while you're there

`margin-left` at 2448, 3014; `margin-left:auto;margin-right:8px` at 2655;
`align-items:flex-end` at 2374, 2514 is fine (flex is logical already).
`text-align:center` at 2548 is fine.

---

## 6. Things that flip automatically (no JS needed)

- Everything in styles.css uses `inline-start/end`. Status bars on
  registration rows, the leader bar on standings, error bars, `.gtag`
  spacing and the toggle knob all mirror under `dir="rtl"`.
- `.hlane-arrow` and `.brnd-arrow` (`→`) flip via `[dir=rtl]`.
- Use `.flip-rtl` on any other directional glyph you print: ▶ ↗ → ←.
  Do not flip ↑ ↓ ✕ ✓ ↺.
- Scores (`.sw`), times (`.tlbl`, `.sv`), phones (`.reg-phone`,
  `.player-db-phone`), `.seed-tag` and tel/url/time/number/password inputs
  are forced LTR in CSS.

---

## 7. Utilities available in styles.css

| Class | Use |
| --- | --- |
| `.bdi` | `unicode-bidi: isolate` for a mixed-direction fragment that is not a `<bdi>` |
| `.num` | LTR + isolate + tabular numerals, for scores, times, counts and dates inside sentences |
| `.flip-rtl` | mirrors a glyph in RTL |

---

## 8. Bracket connector lines in RTL (`drawBracketLines`, 2179–2258)

In RTL, flex puts round 0 on the **right**, so each source box sits to the
right of its destination. The current code draws from the source's right
edge (`rx`) to the destination's left edge (`lx`), which crosses the boxes.

Change `getPos` / the line math like this:

```js
const rtl = getComputedStyle(scroll).direction === 'rtl';
…
const getPos = wrap => {
  const b = wrap.querySelector('.bmatch-box');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const left  = r.left - sR.left + SL;
  const right = left + r.width;
  return {
    // "out" = the edge facing the next round, "in" = the edge facing the previous one
    rx: rtl ? left  : right,
    lx: rtl ? right : left,
    my: r.top - sR.top + ST + r.height / 2
  };
};
```

…and in the 2:1 branch replace `Math.max(s0.rx, s1?.rx ?? s0.rx)` with
`(rtl ? Math.min : Math.max)(s0.rx, s1?.rx ?? s0.rx)`. Nothing else changes:
`vx` is the midpoint, so it is correct in both directions.

The SVG itself: keep it at `left:0` and sized to `scrollWidth`, but in RTL
`scrollLeft` is **0 or negative** (Chrome/Firefox/Safari today) while the
content starts at the right. Since `getPos` adds `SL` to coordinates measured
from `sR.left`, and the SVG is positioned at the scroller's left padding edge,
set the SVG's `left` to `Math.min(0, scroll.clientWidth - scroll.scrollWidth)`
px when `rtl`. That is the x of the content's left edge relative to the
scroller in RTL. Simplest robust alternative: before drawing, set
`scroll.scrollLeft = 0`, draw, then restore. The inline `style.left` set by
JS wins over the `[dir=rtl] .bsvg { right: 0 }` fallback in CSS, so either
approach works.

Also set the stroke to `currentColor` or remove the attribute. CSS already
recolours it to `--border2`.

---

## 9. Verify

```sh
node --check app.js
node --check i18n.js
# key parity (every key used here exists in he and en):
node /path/to/check-wiring-keys.mjs I18N_WIRING.md i18n.js
```

The check script used by Lane E lives outside the repo. It is roughly: collect
every backticked `prefix.name` from this file where prefix ∈ {common, reg,
parts, sched, stand, bracket, build, settings, admin, errors, score, terms,
lang}, then assert `hasKey(k,'he') && hasKey(k,'en')` from `i18n.js`.

Click-through for the owner after wiring:
1. `?t=<id>` in a fresh browser shows Hebrew and RTL. The tabs read הרשמה / נרשמים.
2. Tap EN: the whole UI flips to LTR English, and a reload keeps EN (localStorage `luz-lang`).
3. Hebrew pair names in EN mode are right-aligned in game rows, standings and the bracket.
4. Scores read `21 : 15` in both directions, and times are not reversed.
5. Bracket lines connect boxes in both directions (lines are now visible grey).
6. Settings toggles: the knob moves toward inline-end in both directions.
7. A wrong score shows a Hebrew error ("צריך להגיע ל-21 · למשל 21–15").
