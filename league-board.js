// ============================================================================
// league-board.js — לוח הגרירה של המנהלת. שלב 5 מתוך §14 במפרט.
//
// שלוש תצוגות על אותם נתונים (§8.1–8.2), גרירה שעובדת גם במגע (Pointer Events,
// לא HTML5 drag — §8.1), כל אזהרות §9, בטל/בצע-שוב, "שחזר לתחילת היום",
// "סדר לי את היום מחדש", מגירת המשחקים והאריחים (§8.3), ומונה אורך היום (§4.6).
//
// שדרוג 25.7 (בקשות המשתמשת):
//   • שמירת מיקום גלילה בכל רינדור — המסך לא קופץ למעלה בכל מהלך.
//   • חיפוש חי (בזמן הקלדה) שמדגיש את משחקי הקבוצה בכל התצוגות.
//   • מודל "בחירה → אפשרויות" בסגנון שחמט: הקשה על משחק מדגישה את קבוצותיו;
//     הקשה על תא פנוי מסמנת אילו משחקי-מגירה מותר לשים שם (🟢), אילו אפשריים
//     (רגיל), ואילו אסורים (דהוי, לא לחיץ). עובד בשני הכיוונים.
//   • גרירה על תא תפוס → המשחק הקיים עובר למגירה (החלטת המשתמשת). החלפה
//     נשמרת במחווה: הקשה על משחק אחד ואז על שני = החלפה.
//   • גלילה אוטומטית מבוססת-קרבה בזמן גרירה (ממשיכה כל עוד מחזיקים בקצה).
//
// חוזה §5.3: אין window.* globals. פעולות הלוח בקידומת board.* וכל מטפל קורא
// בעצמו ל-queueSave/repaint. מאזיני Pointer/Click/Input יושבים ברמת המסמך פעם
// אחת ושורדים כל רינדור.
// ============================================================================

import { escH } from './common.js?v=2';
import {
  generateSeason, buildDayContext, dayCost, dayLength, slotLabel, availWindow
} from './league-sched.js?v=6';

// ============================================================================
// ההקשר המוזרק מ-league.js
// ============================================================================
let X = null;   // { getL, queueSave, repaint, schedInput, regularDays, findTeam,
                //   findGame, teamName, netName, netColor, catName, slotTime,
                //   dayEndTime, renderGameEntry, leagueId, isDev }
const L = () => X.getL();

// ============================================================================
// מצב תצוגה (חי בדפדפן בלבד — לא נשמר במסמך)
// ============================================================================
let view      = 'day';    // 'season' | 'day'
let boardDay  = null;     // איזה יום מוצג בתצוגת יום
let selTeam   = null;     // הדגשת קבוצה בודדת (שמור לעתיד; מודגש בטקסט hl-a)
let teamQuery = '';        // חיפוש חי (§8.6)

// מודל הבחירה: או שנבחר משחק (ממתין ליעד), או שנבחר תא פנוי (ממתין למשחק).
//   null | { kind:'game', id } | { kind:'cell', day, slot, net }
let pick = null;
let warnsOpen = false;   // סרגל האזהרות מורחב?
let leagueFilter = null; // הצג רק ליגה אחת (null=הכל) — §5
let fixNote = null;      // "מה תיקנתי" — הודעה קצרה אחרי "תקן לי" (§4 שקיפות)
let resultsOpen = false; // פאנל הזנת התוצאות פתוח? (מתג — כדי שלא יגזול גובה מהגריד)

// בטל / בצע שוב — עותקים מלאים (המצב קטן, 240 משחקים). "שחזר לתחילת היום" נתפס
// עצלנית ליום ברגע פתיחתו בסשן.
const undoStack = [];
const redoStack = [];
const MAX_HIST  = 60;
const dayStart  = {};   // { dayId: { place:Map(gid→{slot,net,locked}), blocks:[] } }

const clone = o => JSON.parse(JSON.stringify(o));
const uid   = p => p + Math.random().toString(36).slice(2, 8);

function init(ctx) {
  X = ctx;
  attachListeners();
}

// ============================================================================
// עזרי מצב
// ============================================================================
const days       = () => X.regularDays();
const dayById    = id => days().find(d => d.id === id) || days()[0];
const gamesOf    = dayId => (L().games || []).filter(g => g.day === dayId);
const blocksOf   = dayId => (L().blocks || []).filter(b => b.day === dayId);
const netsOf     = day => [...(day.netIds || [])].sort((a, b) => a - b);
const unassigned = () => (L().games || []).filter(g => !g.slot || !g.net);
const escLabel   = id => escH(dayById(id)?.label || id);
const teamName   = id => X.teamName(id);
const pairName   = g => `${teamName(g.a)} / ${teamName(g.b)}`;

function cellIndex(dayId) {
  const m = new Map();
  for (const g of gamesOf(dayId)) if (g.slot && g.net) m.set(g.slot + '|' + g.net, g);
  return m;
}
function blockIndex(dayId) {
  const m = new Map();
  for (const b of blocksOf(dayId)) m.set(b.slot + '|' + b.net, b);
  return m;
}
const shareTeam   = (o, g) => o.a === g.a || o.a === g.b || o.b === g.a || o.b === g.b;
const sharedWho   = (o, g) => (o.a === g.a || o.b === g.a) ? g.a : g.b;
const pickGame    = () => pick?.kind === 'game' ? X.findGame(pick.id) : null;

// אילו ליגות מתירות רצף (ליגה ב׳) — רצף בהן "מותר מדי פעם", לא הפרה.
function allowConsecTeams() {
  const s = new Set();
  const cats = new Set((L().categories || []).filter(c => c.allowConsecutive).map(c => c.id));
  for (const g of (L().games || [])) if (cats.has(g.cat)) { s.add(g.a); s.add(g.b); }
  return s;
}

// buildDayContext + dayCost ליום — אותה פונקציית עלות של §6.2 שמזינה את §9.
function dayAnalysis(dayId) {
  const input = X.schedInput();
  const dGames = (input.existing || []).filter(g => g.day === dayId);
  const day = dayById(dayId);
  const total = {};
  for (const g of (input.existing || [])) { total[g.a] = (total[g.a] || 0) + 1; total[g.b] = (total[g.b] || 0) + 1; }
  const D = Math.max(1, (input.days || []).length);
  const bounds = {};
  for (const [t, n] of Object.entries(total)) bounds[t] = { lo: Math.floor(n / D), hi: Math.ceil(n / D) };
  const ctx = buildDayContext(input, day, dGames, bounds);
  const place = new Map();
  for (const g of dGames) if (g.slot && g.net) place.set(g.key, { slot: g.slot, net: g.net });
  return { day, ctx, cost: dayCost(place, ctx), length: dayLength(place, ctx) };
}

// ============================================================================
// היסטוריה + שמירה + רינדור ששומר גלילה
// ============================================================================
function snapshot() { return { games: clone(L().games || []), blocks: clone(L().blocks || []) }; }
function restore(s) { L().games = clone(s.games); L().blocks = clone(s.blocks); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > MAX_HIST) undoStack.shift(); redoStack.length = 0; }

function captureDayStart(dayId) {
  if (dayStart[dayId]) return;
  const place = new Map();
  for (const g of gamesOf(dayId)) place.set(g.id, { slot: g.slot, net: g.net, locked: !!g.locked });
  dayStart[dayId] = { place, blocks: clone(blocksOf(dayId)) };
}

// שמירת מיקום גלילה על פני רינדור. שורש קפיצת-המסך: paint() מחליף innerHTML
// ומאפס גלילה (חלון + הגריד הפנימי). לוכדים לפני, משחזרים ב-rAF אחרי.
function captureScroll() {
  const m = {};
  document.querySelectorAll('.board-scroll[data-sk]').forEach(el => m[el.dataset.sk] = { t: el.scrollTop, l: el.scrollLeft });
  return { x: window.scrollX, y: window.scrollY, m };
}
function restoreScroll(s) {
  window.scrollTo(s.x, s.y);
  document.querySelectorAll('.board-scroll[data-sk]').forEach(el => {
    const v = s.m[el.dataset.sk];
    // void scrollHeight מכריח layout כדי שקביעת scrollTop לא תיחתך ל-0 לפני
    // שהתוכן החדש נמדד. סינכרוני במכוון: requestAnimationFrame מושהה כשהטאב
    // מוסתר, וגלילה לא הייתה משתחזרת ברקע.
    if (v) { void el.scrollHeight; el.scrollTop = v.t; el.scrollLeft = v.l; }
  });
}
// רינדור מלא ששומר גלילה. חשוב: fitGrid() רץ **לפני** restoreScroll — אחרת הגריד
// עדיין בגובהו המלא (לא ניתן לגלילה) ושחזור scrollTop מתפספס, והדף/גריד קופץ לראש
// אחרי שהחסימה נכנסת. סינכרוני במכוון.
function boardRepaint() { const s = captureScroll(); X.repaint(); fitGrid(); restoreScroll(s); fixNote = null; }
function commit()       { X.queueSave(); boardRepaint(); }

// הגריד נכנס למסך בלי גלילת-דף (§2/§11): מותחים את גובהו לגובה הזמין בפועל (חלון
// פחות הכרום מעל, פחות כל מה שמתחת — סרגל אזהרות/עזרה/תוצאות). עובד לשתי התצוגות:
// ביום זה מכניס את כל הסלוטים; בעונה זה מכניס את כל השורות (במחשב — בקשת המשתמשת).
// CSS לבד לא יכול — הוא לא יודע את ה-top של הגריד.
function fitGrid() {
  if (window.innerHeight <= 0) return;
  const grid = document.querySelector('.board-scroll'); if (!grid) return;
  grid.style.maxHeight = '';                         // מדידה נקייה
  const rect = grid.getBoundingClientRect();
  const docTop = rect.top + window.scrollY;
  // כל מה שמתחת לגריד (פאנלים, רווחים, ריפוד) — בלתי-תלוי בגובה הגריד:
  const below = document.documentElement.scrollHeight - (rect.bottom + window.scrollY);
  // בלי שולי-ביטחון: below כבר כולל את סרגל האזהרות/המקרא, אז הגריד ממלא בדיוק
  // עד תחתית החלון והדף לא גולל (§2). Math.floor מונע גלישת תת-פיקסל.
  const avail = Math.floor(window.innerHeight - docTop - below);
  grid.style.maxHeight = (avail > 160 ? avail : 160) + 'px';
}

// כל מהלך שמשנה נתונים עובר דרך זה: תופס undo, ואם נכשל (או המשתמשת ביטלה
// בדיאלוג) משחזר את המצב במלואו — כך מהלך חלקי לא נשאר על המסך.
function tryOp(fn) {
  pushUndo();
  let ok = false;
  try { ok = fn(); } catch (e) { console.error('board op failed', e); ok = false; }
  if (ok) commit();
  else { restore(undoStack.pop()); boardRepaint(); }
}

// ============================================================================
// מהלכי שיבוץ
// ============================================================================

// סיווג שיבוץ מוצע של משחק g בתא (day,slot,net) — לרמזי המגירה ולבדיקת הקשה.
//   'no'   — אסור (קבוצה כבר בסלוט, תא חסום, מחוץ לחלון זמינות, רשת קבועה)
//   'soft' — אפשרי אך מפר חוק לא-קריטי (רצף לא-מותר, המתנה ארוכה)
//   'ok'   — חוקי לגמרי
// exclude: Set של מזהי משחקים שיוצאים מהתא (בהחלפה) — מתעלמים מהם בבדיקות.
function classifyPlacement(g, day, slot, net, exclude) {
  const skip = id => id === g.id || (exclude && exclude.has(id));
  if (blockIndex(day).has(slot + '|' + net)) return 'no';
  const cat = (L().categories || []).find(c => c.id === g.cat);
  if (cat?.fixedNet && net !== cat.fixedNet) return 'no';

  const dObj = dayById(day);
  for (const t of [g.a, g.b]) {
    // אותה קבוצה כבר משחקת בסלוט הזה (ברשת אחרת)
    if (gamesOf(day).some(o => !skip(o.id) && o.slot === slot && (o.a === t || o.b === t))) return 'no';
    // חלון זמינות
    const w = L().availability?.[day]?.[t];
    if (w) { const win = availWindow(dObj, w); if (slot < win.from || slot > win.to) return 'no'; }
  }

  // 'soft' = אפשרי אך מפר חוק כתום של §9 (רצף לא-מותר / יותר מ-4 ביום). המתנה
  // ארוכה היא 🔵 מידע ב-§9 (לא אזהרה), ולכן אינה מורידה מ-🟢 — אפשר לשים שם.
  const allow = allowConsecTeams();
  let soft = false;
  for (const t of [g.a, g.b]) {
    const slots = gamesOf(day).filter(o => !skip(o.id) && (o.a === t || o.b === t) && o.slot).map(o => o.slot);
    const below = slots.filter(s => s < slot).length ? Math.max(...slots.filter(s => s < slot)) : null;
    const above = slots.filter(s => s > slot).length ? Math.min(...slots.filter(s => s > slot)) : null;
    if ((below === slot - 1 || above === slot + 1) && !allow.has(t)) soft = true;   // רצף (כתום)
    if (slots.length + 1 > 4) soft = true;                                          // יותר מ-4 ביום (כתום)
  }
  return soft ? 'soft' : 'ok';
}

// סיווג החלפה בין שני משחקים (לרמזי בחירת-משחק). share-team → אין טעם. אחרת:
// כל אחד "נוחת" בתא של השני (תוך התעלמות מהיוצא). משחק במגירה נשאר בלי תא.
function classifySwap(a, b) {
  if (!a || !b || a.id === b.id || shareTeam(a, b)) return 'no';
  let ca = 'ok', cb = 'ok';
  if (b.slot && b.net) ca = classifyPlacement(a, b.day, b.slot, b.net, new Set([b.id]));   // a → תא של b
  if (a.slot && a.net) cb = classifyPlacement(b, a.day, a.slot, a.net, new Set([a.id]));   // b → תא של a
  if (ca === 'no' || cb === 'no') return 'no';
  return (ca === 'soft' || cb === 'soft') ? 'soft' : 'ok';
}

// גרירה/הצבה של משחק לתא. מטפל בכל §9:
//   • רשת קבועה / תא חסום → נדחה.
//   • קבוצה כבר בסלוט (חסימה אדומה) → מציע לשלוח את המתנגש למגירה.
//   • תא תפוס → המשחק הקיים עובר למגירה (החלטת המשתמשת).
//   • opts.confirm!==false → אישור-לעקוף על הפרה כתומה חדשה (בגרירה בלבד).
// לא כותב/מרנדר — tryOp עושה זאת, ומשחזר אם מוחזר false.
function dragMove(g, day, slot, net, opts = {}) {
  if (g.locked) { alert('המשחק נעול 📌 — בטלי נעילה כדי להזיז.'); return false; }
  if (blockIndex(day).has(slot + '|' + net)) { alert('התא חסום (ליגה שלישית / הפסקה / טקס).'); return false; }
  const cat = (L().categories || []).find(c => c.id === g.cat);
  if (cat?.fixedNet && net !== cat.fixedNet) { alert(`${X.catName(g.cat)} משחקת רק על ${X.netName(cat.fixedNet)}.`); return false; }

  const occ = cellIndex(day).get(slot + '|' + net);
  const before = new Set([day, g.day].filter(Boolean).flatMap(dayViolations).map(violSig));

  // חסימה אדומה: קבוצה של g כבר משחקת בסלוט (ברשת אחרת), פרט לתא שנפנה עכשיו.
  const clash = gamesOf(day).find(o => o.id !== g.id && o.id !== occ?.id && o.slot === slot && shareTeam(o, g));
  if (clash) {
    if (!confirm(`אי אפשר — ל${teamName(sharedWho(clash, g))} כבר יש משחק ב-${slotLabel(dayById(day), slot)} על ${X.netName(clash.net)}. לשלוח אותו למגירה ולשבץ כאן?`))
      return false;
    clash.slot = null; clash.net = null;
  }
  // תא תפוס → הקיים למגירה (bump)
  if (occ && occ.id !== g.id) {
    if (occ.locked) { alert('המשחק שכבר בתא נעול 📌.'); return false; }
    occ.slot = null; occ.net = null;
  }

  g.day = day; g.slot = slot; g.net = net;
  if (opts.confirm !== false && !confirmNew(before, day, ...(g.day === day ? [] : [g.day]))) return false;
  return true;
}

// החלפת מיקום בין שני משחקים (מחוות הקשה-הקשה). אחד מהם יכול להיות במגירה.
function swapGames(a, b) {
  if (a.locked || b.locked) { alert('אחד המשחקים נעול 📌.'); return false; }
  const A = { day: a.day, slot: a.slot, net: a.net };
  a.day = b.day; a.slot = b.slot; a.net = b.net;
  b.day = A.day; b.slot = A.slot; b.net = A.net;
  for (const d of new Set([a.day, b.day].filter(Boolean)))
    if (dayViolations(d).some(v => v.cls === 'block')) { alert('ההחלפה יוצרת התנגשות. לא בוצעה.'); return false; }
  return true;
}

// אישור-לעקוף על הפרות כתומות חדשות (§9). מחזיר true להמשיך.
function confirmNew(beforeSet, ...affected) {
  const now = [];
  for (const d of new Set(affected.filter(Boolean)))
    for (const v of dayViolations(d))
      if (v.cls === 'soft' && overridable(v) && !beforeSet.has(violSig(v))) now.push(v);
  if (!now.length) return true;
  const lines = now.slice(0, 5).map(v => '• ' + v.text);
  if (now.length > 5) lines.push(`• ועוד ${now.length - 5}`);
  return confirm(lines.join('\n') + '\n\nלהמשיך בכל זאת?');
}

function unassign(g) { if (g.locked) { alert('המשחק נעול 📌.'); return false; } g.slot = null; g.net = null; return true; }

function dropTile(kind, day, slot, net) {
  if (cellIndex(day).get(slot + '|' + net) || blockIndex(day).has(slot + '|' + net)) { alert('התא כבר תפוס.'); return false; }
  const labels = { liga3: 'ליגה שלישית', break: 'הפסקה', ceremony: 'צילום / טקס' };
  (L().blocks ||= []).push({ id: uid('b'), day, slot, net, kind, label: labels[kind] || kind });
  return true;
}

// ============================================================================
// מגבלת-מגרש (מגרש זמין עד שעה — למשל אין תאורה) — ממומש כחסימות kind:'netcut',
// כך שהמתזמן מכבד אותן אוטומטית (אילוץ קשיח, בלי לגעת בקוד המתזמן). per-day.
// ============================================================================
const hhmmToMin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const netCutBlocks = (day, net) => (L().blocks || []).filter(b => b.kind === 'netcut' && b.day === day && b.net === net);
function netCutOf(day, net) { const b = netCutBlocks(day, net)[0]; return b ? b.until : null; }

// בונה חסימות netcut ל-(day,net) מהשעה until עד סוף היום (מסיר קודם קיימות).
// unassignOccupied=true → משחק על תא שנחסם עובר לקופסה; אחרת התא לא ייחסם (דילוג).
function setNetCutBlocks(day, net, until, unassignOccupied) {
  L().blocks = (L().blocks || []).filter(b => !(b.kind === 'netcut' && b.day === day && b.net === net));
  if (!until) return;
  const dObj = dayById(day), ci = cellIndex(day), cut = hhmmToMin(until);
  for (let s = 1; s <= dObj.slots; s++) {
    if (hhmmToMin(slotLabel(dObj, s)) < cut) continue;   // רק סלוטים מ-until והלאה
    const g = ci.get(s + '|' + net);
    if (g) { if (unassignOccupied && !g.locked) { g.slot = null; g.net = null; } else continue; }
    (L().blocks ||= []).push({ id: uid('nc'), day, net, slot: s, kind: 'netcut', until, label: 'עד ' + until });
  }
}
// אחרי שינוי slots — לבנות מחדש חסימות של מגרשים מוגבלים (סלוט חדש אחרי הזמן ייחסם).
function applyNetCuts(day) {
  const dObj = dayById(day);
  for (const n of netsOf(dObj)) { const u = netCutOf(day, n); if (u) setNetCutBlocks(day, n, u, false); }
}
// הגדרה מלאה מהלוח/הגדרות: אם יש משחקים תפוסים אחרי השעה — מאשרים פינוי לקופסה.
function setNetCut(day, net, until) {
  if (until) {
    const dObj = dayById(day), cut = hhmmToMin(until);
    const occ = gamesOf(day).filter(g => g.net === net && g.slot && g.slot <= dObj.slots && hhmmToMin(slotLabel(dObj, g.slot)) >= cut);
    if (occ.length && !confirm(`יש ${occ.length} משחקים על ${X.netName(net)} מ-${until} והלאה. לפנות אותם לקופסה ולסגור את המגרש בשעות האלה?`)) return;
  }
  tryOp(() => { setNetCutBlocks(day, net, until, true); return true; });
}

// ============================================================================
// אזהרות (§9)
// ============================================================================
const violSig = v => `${v.kind}|${v.team || v.net || ''}|${v.slot || ''}`;

// העדפות מתזמן פנימיות (§6.2) — לא אזהרות §9 של המנהלת. מסוננות מהסרגל כדי שלא
// יצעק "בעיות" על אופטימיזציה: רצף-קטגוריה, הוגנות מוקדם/מאוחר, קפיצות-רשת,
// תא-ריק-מוקדם ושעת-סיום (הראשונים by-design §6.3; שעת הסיום מוצגת במונה המגירה §4.6).
const SCHED_ONLY = new Set(['netJump', 'catReturn', 'fairness', 'emptyEarly', 'lateFinish', 'showNotNet1']);
function classify(v, allowSet) {
  if (SCHED_ONLY.has(v.kind)) return 'skip';
  if (v.kind === 'doubleBooked') return 'block';
  if (v.kind === 'backToBack') return allowSet.has(v.team) ? 'allowed' : 'soft';
  if (v.kind === 'longWait') return 'info';
  if (v.kind === 'noGames') return 'soft';
  if (v.cost >= 1_000_000) return 'block';
  return 'soft';
}
const overridable = v => ['availability', 'noReferee', 'backToBack', 'tooMany', 'tooFew', 'noGames'].includes(v.kind);

function violText(v, day) {
  const tm = v.team ? teamName(v.team) : '';
  const at = v.slot ? slotLabel(day, v.slot) : '';
  const nt = v.net ? X.netName(v.net) : '';
  switch (v.kind) {
    case 'doubleBooked': return `אי אפשר — ל${tm} כבר יש משחק ב-${at}.`;
    case 'backToBack':   return `${tm} ישחקו פעמיים ברצף (${at}).`;
    case 'tooMany':      return `ל${tm} יהיו יותר מ-4 משחקים ביום.`;
    case 'tooFew':       return `ל${tm} יהיו פחות מ-3 משחקים ביום.`;
    case 'noGames':      return `${tm} בלי אף משחק ביום.`;
    case 'availability': return `${tm} ביקשו חלון זמן אחר — המשחק ב-${at} חורג ממנו.`;
    case 'noReferee':    return `שתי הקבוצות ב-${at} ${nt} ממשיכות לסלוט הבא — אין מי שישפוט.`;
    case 'longWait':     return `${tm} ממתינה יותר מסלוט אחד.`;
    case 'cellClash':    return `שני משחקים על אותו תא (${at} ${nt}).`;
    case 'blockedCell':  return `משחק על תא חסום (${at} ${nt}).`;
    default:             return v.text || v.kind;
  }
}

function dayViolations(dayId) {
  const { cost, day } = dayAnalysis(dayId);
  const allowSet = allowConsecTeams();
  const out = [];
  for (const v of (cost.violations || [])) {
    const cls = classify(v, allowSet);
    if (cls === 'skip') continue;
    out.push({ ...v, cls, dayId, text: violText(v, day) });
  }
  return out;
}
function boardWarnings() {
  const dd = view === 'season' ? days().map(d => d.id) : [boardDay].filter(Boolean);
  return dd.flatMap(dayViolations);
}
// רק הבעיות ה"אמיתיות" (אדומות/כתומות), בסדר יציב — האינדקס משמש קפיצה ותיקון.
const realProblems = () => boardWarnings().filter(v => v.cls === 'block' || v.cls === 'soft');

// בעיות שהזזת משחק בתוך היום פותרת (ולכן ל"תקן לי" יש מה לעשות). tooMany/tooFew/
// noGames דורשים הוספה/הסרה של משחק, לא הזזה — להם רק הצעה בטקסט.
const FIXABLE = new Set(['backToBack', 'availability', 'noReferee', 'doubleBooked', 'cellClash', 'blockedCell']);

// בעיות שדורשות הוספה/הסרה של משחק (לא הזזה) — אין להן "תקן לי". במקום זה: קישור
// שמדליק את כל משחקי הקבוצה כדי לראות מה לשנות (§4), ולחוסר-משחקים גם צ׳יפים של
// משחקי-קופסה של אותה קבוצה (אם יש) — "כמה אופציות" לבחור מהן.
const ADDREMOVE = new Set(['tooMany', 'tooFew', 'noGames']);
function violExtra(v) {
  if (!ADDREMOVE.has(v.kind) || !v.team) return '';
  const t = v.team, on = selTeam === t ? ' on' : '';
  let chips = '';
  if (v.kind === 'tooFew' || v.kind === 'noGames') {
    const box = unassigned().filter(g => g.a === t || g.b === t);
    chips = box.length
      ? box.slice(0, 4).map(g => `<button class="wb-chip" data-act="board.pickBoxGame" data-game="${escH(g.id)}" title="בחרי כדי לראות לאן אפשר לשבץ">＋ ${escH(pairName(g))}</button>`).join('')
      : `<span class="wb-chip-none">אין לקבוצה משחק בקופסה — כדי להוסיף צריך לפצל משחק מיום אחר.</span>`;
  }
  return `<div class="wb-extra">
    <button class="wb-team${on}" data-act="board.highlightTeam" data-team="${escH(t)}">🔦 הראה את כל משחקי ${escH(teamName(t))}</button>${chips}</div>`;
}

// הצעת פתרון קצרה לכל סוג בעיה (§9).
function suggestFix(v) {
  switch (v.kind) {
    case 'backToBack':   return 'הזיזי אחד משני המשחקים הצמודים לסלוט אחר.';
    case 'tooMany':      return 'צריך להסיר מהקבוצה משחק ביום הזה — הזיזי אחד לקופסה.';
    case 'tooFew':       return 'צריך להוסיף לקבוצה משחק ביום הזה — ראי אפשרויות למטה.';
    case 'noGames':      return 'צריך לשבץ לקבוצה משחק ביום הזה (או לסמן היעדרות בדירוג).';
    case 'availability': return 'הזיזי את המשחק לתוך חלון הזמן שהקבוצה ביקשה.';
    case 'noReferee':    return 'הזיזי אחת הקבוצות כדי שתהיה פנויה לשפוט בסלוט הבא.';
    case 'doubleBooked': return 'לקבוצה שני משחקים באותו סלוט — הזיזי אחד מהם.';
    case 'cellClash':    return 'שני משחקים על אותו תא — הזיזי אחד.';
    case 'blockedCell':  return 'המשחק על תא חסום — הזיזי אותו לתא פנוי.';
    default:             return 'הזיזי את המשחק לתא אחר, או "סדר מחדש".';
  }
}

// אזהרות ≠ בעיות (§3): בעיה (block, אדום — חובה) מול אזהרה (soft, כתום — עבירה).
function warnBar() {
  const all = boardWarnings();
  const real = all.filter(v => v.cls === 'block' || v.cls === 'soft');   // אותו סדר כמו realProblems()
  const problems = [], warnings = [];
  real.forEach((v, i) => (v.cls === 'block' ? problems : warnings).push({ v, i }));
  const info = all.filter(v => v.cls === 'info');       // המתנות ארוכות (§9 🔵)
  const allowed = all.filter(v => v.cls === 'allowed'); // רצף מותר בליגה ב׳
  const ok = real.length === 0;
  const cls = problems.length ? ' has-prob' : warnings.length ? ' has-warn' : ' ok';

  const head = `<div class="wb-head">
    ${ok ? `<span class="wb-ok">✓ הכול תקין</span>` : ''}
    ${problems.length ? `<button class="wb-toggle prob${warnsOpen ? ' open' : ''}" data-act="board.toggleWarns">⛔ ${problems.length} ${problems.length === 1 ? 'בעיה' : 'בעיות'} <span class="wb-caret">▾</span></button>` : ''}
    ${warnings.length ? `<button class="wb-toggle warn${warnsOpen ? ' open' : ''}" data-act="board.toggleWarns">⚠ ${warnings.length} ${warnings.length === 1 ? 'אזהרה' : 'אזהרות'} <span class="wb-caret">▾</span></button>` : ''}
    ${allowed.length ? `<span class="wb-note ok">${allowed.length} רצף מותר בליגה ב׳</span>` : ''}
    ${info.length ? `<button class="wb-note wb-info" data-act="board.toggleWarns">🔵 ${info.length} ${info.length === 1 ? 'קבוצה ממתינה' : 'קבוצות ממתינות'} — לא קריטי</button>` : ''}
    ${fixNote ? `<span class="wb-fixnote">✨ ${escH(fixNote)}</span>` : ''}
  </div>`;

  let body = '';
  if (warnsOpen && (real.length || info.length)) {
    const row = ({ v, i }) => `<div class="wb-prob ${v.cls}">
      <div class="wb-prob-row">
        <button class="wb-prob-main" data-act="board.gotoViol" data-i="${i}" title="הראה איפה זה, וסמן אפשרויות">
          <span class="wb-prob-t">${view === 'season' ? escLabel(v.dayId) + ' · ' : ''}${escH(v.text)}</span>
          <span class="wb-prob-fix">💡 ${escH(suggestFix(v))}</span>
        </button>
        ${FIXABLE.has(v.kind) ? `<button class="wb-fix" data-act="board.fixViol" data-i="${i}">✨ תקן לי</button>` : ''}
      </div>
      ${violExtra(v)}
    </div>`;
    const grp = (title, arr, k) => arr.length ? `<div class="wb-grp ${k}"><div class="wb-grp-h">${title}</div>${arr.map(row).join('')}</div>` : '';
    const waits = info.length ? `<div class="wb-waits">🔵 <b>המתנות ארוכות</b> (יותר מסלוט בין משחקים) — לא בעיה, רק פחות אידיאלי: ${
      [...new Set(info.map(v => teamName(v.team)))].slice(0, 10).map(escH).join(' · ')}${info.length > 10 ? ' …' : ''}</div>` : '';
    body = `<div class="wb-body">${grp('בעיות — חובה לתקן', problems, 'prob')}${grp('אזהרות — אפשר להשאיר', warnings, 'warn')}${waits}</div>`;
  }
  return `<div class="warnbar${cls}">${head}${body}</div>`;
}

// מזהה את המשחק שאחראי לבעיה, כדי להזיז אותו ב"תקן לי".
function violGame(v) {
  const dG = gamesOf(v.dayId);
  if (v.slot && v.net) { const g = dG.find(x => x.slot === v.slot && x.net === v.net); if (g) return g; }
  if (v.team && v.slot) { const g = dG.find(x => x.slot === v.slot && (x.a === v.team || x.b === v.team)); if (g) return g; }
  if (v.team) return dG.find(x => x.a === v.team || x.b === v.team);
  return null;
}

// "תקן לי" (§4): פותר את הבעיה לפי **עלות המתזמן המלאה** (§6.2), כדי שלא ייווצרו
// חורים בלוז (בקשת המשתמשת). מנסה: 1) הזזה לתא פנוי  2) החלפה עם משחק אחר (ניטרלית
// לחורים) — ובוחר את בעל העלות הכוללת הנמוכה ביותר. אין "bump" (הוא יוצר חור + משחק
// לא-משובץ). אם אין מהלך יחיד טוב — נופל ל"סדר מחדש" (המתזמן פורק את היום בלי חורים).
// אחרי הביצוע — **מראה מה נעשה** (fixNote + הבהוב הכרטיסים שזזו).
function fixViol(index) {
  const v = realProblems()[index]; if (!v) return;
  const day = v.dayId, g = violGame(v);
  if (!g || g.locked) { alert('לא הצלחתי לזהות משחק פנוי להזזה. נסי "סדר מחדש".'); return; }
  const target = violSig(v), dayObj = dayById(day), nets = netsOf(dayObj);
  const ci = cellIndex(day), bi = blockIndex(day);
  // §5: תיאור מלא — כל זוג שנגע בו, עם שעת-היעד שלו.
  const pair = x => `${teamName(x.a)} / ${teamName(x.b)}`;
  const spot = (s, n) => `${slotLabel(dayObj, s)} · ${X.netName(n)}`;
  // דירוג המהלכים לפי **עלות המתזמן המלאה** (§6.2) — כולל חורים מוקדמים וסיום מאוחר —
  // כדי שהתיקון יפעל לפי חוקי המתזמן ולא ייצור חורים בלוז (בקשת המשתמשת). עדיין פסול
  // (Infinity) אם הבעיה המקורית נשארה או אם נוצרה חסימה חדשה.
  const evalState = () => {
    const { cost } = dayAnalysis(day);
    const allowSet = allowConsecTeams();
    let hasTarget = false, hasBlock = false;
    for (const x of (cost.violations || [])) {
      const cls = classify(x, allowSet);
      if (cls === 'skip') continue;
      if (violSig(x) === target) hasTarget = true;
      if (cls === 'block') hasBlock = true;
    }
    if (hasTarget || hasBlock) return Infinity;
    return cost.total;   // מזעור העלות הכוללת → מעדיף מהלך בלי חורים / סיום מוקדם
  };
  const rank = { move: 0, swap: 1 };   // שובר-שוויון בלבד; העלות הכוללת מכריעה
  let best = null;
  const consider = c => { if (!best || c.bad < best.bad || (c.bad === best.bad && rank[c.kind] < rank[best.kind])) best = c; };

  // 1) הזזה לתא פנוי
  const G = { slot: g.slot, net: g.net };
  for (let s = 1; s <= dayObj.slots; s++) for (const n of nets) {
    const k = s + '|' + n;
    if (ci.get(k) || bi.has(k) || (s === G.slot && n === G.net)) continue;
    g.slot = s; g.net = n; const bad = evalState(); g.slot = G.slot; g.net = G.net;
    if (bad < Infinity) consider({ kind: 'move', bad, gs: s, gn: n, flash: [g.id],
      note: `הזזתי את ${pair(g)} ל-${spot(s, n)}` });
  }
  // 2) החלפה עם משחק משובץ אחר
  for (const h of gamesOf(day)) {
    if (h.id === g.id || h.locked || !h.slot) continue;
    const H = { slot: h.slot, net: h.net };
    g.slot = H.slot; g.net = H.net; h.slot = G.slot; h.net = G.net;
    const bad = evalState();
    g.slot = G.slot; g.net = G.net; h.slot = H.slot; h.net = H.net;
    if (bad < Infinity) consider({ kind: 'swap', bad, hId: h.id, gs: H.slot, gn: H.net, hs: G.slot, hn: G.net, flash: [g.id, h.id],
      note: `החלפתי את ${pair(g)} (→ ${spot(H.slot, H.net)}) עם ${pair(h)} (→ ${spot(G.slot, G.net)})` });
  }
  // (אין bump — הוא מוציא משחק לקופסה ומשאיר חור. אם אין מהלך יחיד — מסדרים מחדש.)
  if (!best) { if (confirm('לא נמצא תיקון במהלך יחיד בלי ליצור חור. לסדר את היום מחדש (שומר נעולים)?')) ACT['board.reorderDay'](); return; }

  const b = best;
  fixNote = b.note;
  tryOp(() => {
    if (b.kind === 'move') { g.slot = b.gs; g.net = b.gn; }
    else { const h = X.findGame(b.hId); g.slot = b.gs; g.net = b.gn; h.slot = b.hs; h.net = b.hn; }   // swap
    return true;
  });
  setTimeout(() => b.flash.forEach(id => {
    const c = document.querySelector(`.bcard[data-game="${id}"]`);
    if (c) { c.classList.add('moved-flash'); setTimeout(() => c.classList.remove('moved-flash'), 1900); }
  }), 90);
}

// ============================================================================
// רינדור כרטיס משחק — הצבע לפי ליגה (גוונים של אותו הצבע), רמזי בחירה/מגירה
// ============================================================================
const LEAGUE_SHORT = { show: 'שואו', liga1: 'ליגה א׳', liga2: 'ליגה ב׳' };
const leagueShort = cat => LEAGUE_SHORT[cat] || X.catName(cat);

// הדגשת טקסט לפי קבוצה (§7): בחירת משחק → זוג A מגנטה, זוג B כחול, בכל מקום
// שהם מופיעים. חיפוש → מרקר צהוב. הטקסט נצבע — לא הקופסה.
function teamHl(teamId) {
  const c = [];
  const pg = pickGame();
  if (pg) { if (teamId === pg.a) c.push('hl-a'); else if (teamId === pg.b) c.push('hl-b'); }
  else if (selTeam && teamId === selTeam) c.push('hl-a');
  const q = teamQuery.toLowerCase();
  if (q && (teamName(teamId) || '').toLowerCase().includes(q)) c.push('hl-search');
  return c.length ? ' ' + c.join(' ') : '';
}

function bcard(g) {
  const picked = pick?.kind === 'game' && pick.id === g.id;
  // רמזי אפשרות: מיקוד תא → משחקי הקופסה · בחירת משחק → מי אפשר להחליף איתו.
  let cand = '';
  if (pick?.kind === 'cell' && (!g.slot || !g.net)) {
    const c = classifyPlacement(g, pick.day, pick.slot, pick.net);
    cand = c === 'ok' ? ' cand-ok' : c === 'no' ? ' cand-no' : '';
  } else if (pick?.kind === 'game' && pick.id !== g.id) {
    const pg = pickGame();
    // כרטיס שחולק קבוצה עם הנבחר = מופע נוסף של הזוג (§1) — לא לעמעם, שהצביעה תיראה.
    if (shareTeam(pg, g)) cand = '';
    else { const c = classifySwap(pg, g); cand = c === 'ok' ? ' cand-ok' : c === 'no' ? ' cand-no' : ''; }
  }
  const dim = leagueFilter && g.cat !== leagueFilter ? ' lg-dim' : '';   // §5
  const cls = `bcard cat-${escH(g.cat)}${picked ? ' picked' : ''}${g.locked ? ' locked' : ''}${cand}${dim}`;
  return `<div class="${cls}" data-drag="game" data-game="${escH(g.id)}" data-day="${escH(g.day || '')}" title="${escH(X.catName(g.cat))}">
    <span class="bc-lg lg-${escH(g.cat)}">${escH(leagueShort(g.cat))}</span>
    <span class="bc-team${teamHl(g.a)}" data-team="${escH(g.a)}">${escH(teamName(g.a))}</span><span class="bc-sep"> · </span><span class="bc-team${teamHl(g.b)}" data-team="${escH(g.b)}">${escH(teamName(g.b))}</span>
    <button class="bc-lock" data-act="board.lock" data-game="${escH(g.id)}" title="${g.locked ? 'נעול' : 'נעילה'}">${g.locked ? '📌' : '📍'}</button>
  </div>`;
}

// ============================================================================
// תצוגת יום (§8.1)
// ============================================================================
function renderDayGrid(dayId) {
  const day = dayById(dayId), nets = netsOf(day);
  const ci = cellIndex(dayId), bi = blockIndex(dayId);
  // כותרת ניטרלית: הרשת כשם טקסט. לחיצה עליה → מגבלת-זמן למגרש (למשל אין תאורה).
  const head = `<tr><th class="bg-time">שעה</th>${nets.map(n => {
    const cut = netCutOf(dayId, n);
    return `<th class="bg-neth"><button class="neth-btn" data-act="board.netCutPrompt" data-net="${n}" data-day="${escH(dayId)}" title="הגדרת שעת סיום למגרש (למשל אם אין תאורה)">${escH(X.netName(n))} <span class="neth-clock">⏰</span>${cut ? `<span class="neth-cut">🔦 עד ${escH(cut)}</span>` : ''}</button></th>`;
  }).join('')}</tr>`;
  const rows = Array.from({ length: day.slots }, (_, i) => {
    const s = i + 1;
    return `<tr><td class="bg-time num">${escH(slotLabel(day, s))}</td>${nets.map(n => cellHtml(dayId, s, n, ci, bi)).join('')}</tr>`;
  }).join('');
  // סרגל "הוסף סלוט" **מתחת** לגריד (לא בתוכו) — תמיד גלוי בתחתית, גם כשהגריד גולל
  // פנימית (בקשת המשתמשת). מאריך את שעות היום; "－" רק אם הסלוט האחרון ריק.
  const lastEmpty = !gamesOf(dayId).some(g => g.slot === day.slots) && !blocksOf(dayId).some(b => b.slot === day.slots);
  const addBar = `<div class="add-slot-bar">
    <button class="add-slot-btn" data-act="board.addSlot" title="מאריך את שעות היום">＋ הוסף סלוט <span class="asr-time">${escH(slotLabel(day, day.slots + 1))}</span></button>
    ${lastEmpty && day.slots > 1 ? `<button class="add-slot-btn rm" data-act="board.removeSlot" title="מקצר את היום — מסיר את הסלוט האחרון הריק">－ הסר אחרון</button>` : ''}
  </div>`;
  return `<div class="board-scroll vscroll" data-sk="day"><table class="board-grid day-grid"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${addBar}`;
}

function cellHtml(dayId, s, n, ci, bi, firstOfDay) {
  const fod = firstOfDay ? ' first-of-day' : '';
  const key = s + '|' + n;
  const b = bi.get(key);
  // חסימת netcut (מגרש סגור בשעה זו) — דהוי, בלי × (מוסירים דרך שעת-המגרש בכותרת);
  // התווית "עד HH:MM" בכותרת, כאן רק אייקון פנס.
  if (b) { const cut = b.kind === 'netcut';
    return `<td class="bcell blocked${cut ? ' netcut' : ''}${fod}" data-cell="${key}" data-day="${escH(dayId)}">
      <span class="blk-lbl">${cut ? '🔦' : escH(b.label || b.kind)}</span>
      ${cut ? '' : `<button class="blk-x" data-act="board.rmBlock" data-id="${escH(b.id)}">×</button>`}</td>`;
  }
  const g = ci.get(key);
  if (g) return `<td class="bcell${fod}" data-cell="${key}" data-day="${escH(dayId)}">${bcard(g)}</td>`;
  // תא פנוי: בחירת משחק → היכן אפשר לשים (🟢/🚫); מיקוד תא → התא הנבחר.
  let hint = '';
  const pg = pickGame();
  if (pick?.kind === 'cell' && pick.day === dayId && pick.slot === s && pick.net === n) hint = ' cell-focused';
  else if (pg) { const c = classifyPlacement(pg, dayId, s, n); hint = c === 'ok' ? ' cell-ok' : c === 'no' ? ' cell-no' : ' cell-soft'; }
  else if (pick?.kind === 'cell') hint = ' tap-target';
  return `<td class="bcell empty${hint}${fod}" data-cell="${key}" data-day="${escH(dayId)}"></td>`;
}

// ============================================================================
// תצוגת עונה (§8.1, החלטה 17)
// ============================================================================
function renderSeason() {
  const dl = days();
  const maxSlots = Math.max(1, ...dl.map(d => d.slots));
  // הפרדה ברורה בין ימים (בקשת המשתמשת): עמודת הרשת הראשונה של כל יום (פרט לראשון)
  // מקבלת first-of-day → קו-מפריד עבה ב-CSS.
  const head1 = `<tr><th class="bg-time" rowspan="2">שעה</th>${dl.map((d, di) =>
    `<th class="season-dayh${di ? ' first-of-day' : ''}" colspan="${netsOf(d).length}" data-day-drop="${escH(d.id)}">${escH(d.label)}</th>`).join('')}</tr>`;
  const head2 = `<tr>${dl.map((d, di) => netsOf(d).map((n, ni) =>
    `<th class="bg-neth mini${di && !ni ? ' first-of-day' : ''}">${escH(X.netName(n)).replace('מגרש ', '')}</th>`).join('')).join('')}</tr>`;
  const idx = dl.map(d => ({ d, ci: cellIndex(d.id), bi: blockIndex(d.id) }));
  const rows = Array.from({ length: maxSlots }, (_, i) => {
    const s = i + 1;
    return `<tr><td class="bg-time num">${escH(slotLabel(dl[0], s))}</td>${
      idx.map(({ d, ci, bi }, di) => netsOf(d).map((n, ni) =>
        s <= d.slots ? cellHtml(d.id, s, n, ci, bi, di && !ni) : `<td class="bcell na${di && !ni ? ' first-of-day' : ''}"></td>`).join('')).join('')
    }</tr>`;
  }).join('');
  return `<div class="board-scroll hscroll" data-sk="season"><table class="board-grid season-grid"><thead>${head1}${head2}</thead><tbody>${rows}</tbody></table></div>`;
}

// (תצוגת "רצועות" הוסרה — בקשת המשתמשת #6. נשארות יום/עונה.)

// ============================================================================
// המגירה (§8.3) — משחקים לא משובצים + אריחים + מונה אורך היום (§4.6)
// ============================================================================
function drawer() {
  const un = unassigned();
  // §11: בלי אריחי הפסקה/צילום — רק ליגה שלישית.
  const tiles = [['liga3', '🟨', 'ליגה שלישית']]
    .map(([k, ic, lbl]) => `<div class="tile" data-drag="tile" data-kind="${k}"><span class="tile-ic">${ic}</span>${escH(lbl)}</div>`).join('');
  const unHtml = un.length ? un.map(g => bcard(g)).join('') : `<div class="drawer-empty">כל המשחקים משובצים.</div>`;
  // רמז לפי מצב הבחירה (§4: לא להזמין פעולה בלתי-אפשרית; §12: לחיצה על הקופסה מוציאה):
  let hint = '';
  if (pick?.kind === 'cell')
    hint = un.length
      ? `<div class="drawer-hint">בחרת תא ${escH(slotLabel(dayById(pick.day), pick.slot))} · ${escH(X.netName(pick.net))}. הקישי משחק להצבה (מסומן = אפשר · דהוי = אסור).</div>`
      : `<div class="drawer-hint empty">הקופסה ריקה — אין משחק להציב כאן. גררי משחק מהלוח לכאן כדי לפנות אותו.</div>`;
  else if (pick?.kind === 'game')
    hint = `<div class="drawer-hint drop">↩ הקישי כאן כדי להוציא את המשחק הנבחר לקופסה.</div>`;
  return `<aside class="drawer" data-drawer>
    <div class="drawer-sec box${pick?.kind === 'game' ? ' can-drop' : ''}" data-boxdrop>
      <div class="drawer-h">קופסת משחקים <span class="muted">${un.length}</span></div>
      ${hint}
      <div class="drawer-un" data-drawer-un>${unHtml}</div>
    </div>
    <div class="drawer-sec"><div class="drawer-h">אריח לגרירה</div><div class="drawer-tiles">${tiles}</div></div>
    ${lenCounter()}
  </aside>`;
}

function lenCounter() {
  if (!boardDay) return '';
  const { length: L2 } = dayAnalysis(boardDay);
  // המספר החשוב — שעת הסיום — גדול וברור; ההיטל הטכני (§4.6) מקופל.
  return `<div class="drawer-sec len-box">
    <div class="len-headline">היום נגמר ב-<b class="num">${escH(L2.endTime)}</b></div>
    <div class="len-now"><span>תפוסים <b class="num">${L2.used}</b></span><span>חסימות <b class="num">${L2.blocks}</b></span></div>
    <details class="len-proj-wrap"><summary>אם נשמור תאים לליגה שלישית</summary>
      <table class="stbl len-proj"><thead><tr><th>תאים</th>${L2.projection.map(p => `<th class="num">${p.extra}</th>`).join('')}</tr></thead>
      <tbody><tr><td>סיום</td>${L2.projection.map(p => `<td class="num">${escH(p.endTime)}</td>`).join('')}</tr></tbody></table></details></div>`;
}

// ============================================================================
// הזנת תוצאות בתוך "לוז" (הועברה מ"דירוג") — מחזר renderGameEntry
// ============================================================================
function resultsPanel(dayId) {
  const gs = gamesOf(dayId).filter(g => g.slot).sort((a, b) => (a.slot - b.slot) || ((a.net || 0) - (b.net || 0)));
  if (!gs.length) return '';
  const filtered = selTeam ? gs.filter(g => g.a === selTeam || g.b === selTeam) : gs;
  const nsd = selTeam ? `<button class="filter-btn nsd-btn" data-act="res.noshowDay" data-team="${escH(selTeam)}" data-day="${escH(dayId)}">היעדרות ליום זה</button>` : '';
  return `<details class="results-panel" open>
    <summary class="sett-section-title">תוצאות ${escLabel(dayId)}${selTeam ? ' — ' + escH(teamName(selTeam)) : ''} <span class="muted">${filtered.length}</span>${nsd}</summary>
    <div class="results-body">${filtered.map(X.renderGameEntry).join('')}</div></details>`;
}

// ============================================================================
// ההרכבה — הפונקציה ש-league.js קורא לה בטאב "לוז"
// ============================================================================
function render() {
  const dl = days();
  if (!dl.length || !(L().games || []).length) {
    return `<div class="info-box">עדיין אין לוז לגרור. צרי אותו בעמוד <b>מתזמן</b> (או הזיני קבוצות בעמוד <b>קבוצות</b>).</div>`;
  }
  if (!boardDay || !dl.find(d => d.id === boardDay)) boardDay = (dl.find(d => gamesOf(d.id).length) || dl[0]).id;
  captureDayStart(boardDay);
  if (view === 'season') dl.forEach(d => captureDayStart(d.id));   // "שחזר הכל" צריך תמונת-פתיחה לכל יום (§9)

  const viewBtns = [['day', 'יום'], ['season', 'עונה']].map(([v, lbl]) =>
    `<button class="filter-btn${view === v ? ' on' : ''}" data-act="board.view" data-v="${v}">${lbl}</button>`).join('');
  const dayPicker = view === 'season' ? '' : `<div class="day-picker">${dl.map(d =>
    `<button class="filter-btn${d.id === boardDay ? ' on' : ''}" data-act="board.day" data-day="${escH(d.id)}">${escH(d.label)}</button>`).join('')}</div>`;

  // מסנן ליגה (§5): "כל הליגות" + כפתור לכל ליגה עם משחקים.
  const cats = (L().categories || []).filter(c => (L().games || []).some(g => g.cat === c.id));
  const leagueBtns = cats.length > 1 ? `<div class="league-filter">
    <button class="filter-btn${!leagueFilter ? ' on' : ''}" data-act="board.league" data-cat="">כל הליגות</button>
    ${cats.map(c => `<button class="filter-btn lgf lgf-${escH(c.id)}${leagueFilter === c.id ? ' on' : ''}" data-act="board.league" data-cat="${escH(c.id)}">${escH(leagueShort(c.id))}</button>`).join('')}
  </div>` : '';

  const q = teamQuery.toLowerCase();
  const matchCount = q ? (L().games || []).filter(g => g.slot && ((teamName(g.a) || '').toLowerCase().includes(q) || (teamName(g.b) || '').toLowerCase().includes(q))).length : 0;
  const counter = q
    ? (matchCount ? `<span class="team-counter" id="board-team-counter">${matchCount} משחקים מודגשים</span>` : `<span class="team-counter no" id="board-team-counter">לא נמצאה קבוצה</span>`)
    : `<span class="team-counter" id="board-team-counter"></span>`;

  // שורה 1: תצוגה + בורר-ימים + כלים. שורה 2: מסנן-ליגה + חיפוש. הכרום צומצם כדי
  // שהגריד יקבל את מרב הגובה — היום נכנס בלי גלילה בגודל קריא (§2/§9, בקשת המשתמשת).
  const toolbar = `<div class="board-toolbar">
    <div class="board-views">${viewBtns}${dayPicker}</div>
    <div class="board-tools">
      <button class="filter-btn" data-act="board.undo"${undoStack.length ? '' : ' disabled'} title="בטל (Ctrl+Z)">↶ בטל</button>
      <button class="filter-btn" data-act="board.redo"${redoStack.length ? '' : ' disabled'} title="בצע שוב (Ctrl+Shift+Z)">↷ בצע שוב</button>
      <button class="filter-btn" data-act="board.restore">↩ ${view === 'season' ? 'שחזר הכל' : 'שחזר יום'}</button>
      ${view === 'season'
        ? `<button class="filter-btn" data-act="board.reorderSeason" title="מסדר מחדש את כל הימים; משחקים נעולים 📌 יישארו במקומם">🗓 תזמן מחדש</button>`
        : `<button class="filter-btn" data-act="board.reorderDay">סדר מחדש</button>
      <button class="filter-btn${resultsOpen ? ' on' : ''}" data-act="board.toggleResults">🏐 תוצאות</button>
      <button class="cf-btn" data-act="board.print">🖨 הדפסה</button>`}
    </div>
  </div>
  <div class="board-subbar">
    ${leagueBtns}
    <div class="board-search">
      <input class="text-inp" id="board-search" placeholder="חיפוש קבוצה…" value="${escH(teamQuery)}" data-act="board.search"/>
      ${teamQuery ? `<button class="team-del" data-act="board.clearSearch" title="נקה">×</button>` : ''}
      ${counter}
      ${pick ? `<span class="tap-hint">${pick.kind === 'game' ? 'בחרת משחק — התאים הצהובים = לאן אפשר · הקישי תא / הקופסה (הוצאה) / משחק אחר (החלפה)' : 'בחרת תא — הקישי משחק מהקופסה'} <button class="team-del" data-act="board.pickClear">×</button></span>` : ''}
    </div>
  </div>`;

  const grid = view === 'season' ? renderSeason() : renderDayGrid(boardDay);
  // הזנת תוצאות במתג — נטענת רק כשפתוח, כדי שלא תגזול גובה מהגריד (§2).
  const results = (view === 'day' && resultsOpen) ? resultsPanel(boardDay) : '';

  // מקרא + עזרה מקופלים יחד בתחתית — לא תופסים גובה כשסגורים (ברירת מחדל).
  const guide = `<details class="board-guide">
    <summary>מקרא ועזרה</summary>
    <div class="bg-legend">
      <span class="lg-key"><span class="bc-lg lg-show">שואו</span></span>
      <span class="lg-key"><span class="bc-lg lg-liga1">ליגה א׳</span></span>
      <span class="lg-key"><span class="bc-lg lg-liga2">ליגה ב׳</span></span>
      <span class="lg-sep"></span>
      <span class="lg-key">זוג נבחר: <b class="hl-a">זוג</b> · <b class="hl-b">זוג</b></span>
      <span class="lg-key">חיפוש: <b class="hl-search">זוג</b></span>
      <span class="lg-key"><span class="lg-sw sw-ok"></span>אפשר לשים</span>
      <span class="lg-key"><span class="lg-sw sw-prob"></span>בעיה</span>
    </div>
    <ul>
      <li><b>לגרור</b> או <b>להקיש</b> משחק ואז תא. הקשה על משחק ואז על הקופסה = הוצאה. הקשה על שני משחקים = החלפה.</li>
      <li>גרירה על תא תפוס → המשחק שהיה שם עובר לקופסה.</li>
      <li>יש בעיה? פתחי את הסרגל למטה, לחצי עליה כדי לראות אותה, או "✨ תקן לי".</li>
      <li class="muted">לוח הגרירה ייפתח למאסטר בלבד בשלב 6 (§7.1).</li>
    </ul>
  </details>`;

  setTimeout(fitGrid, 0);     // מיד אחרי שה-HTML נכנס ל-DOM (§2/§11)
  setTimeout(fitGrid, 160);   // ושוב אחרי שהכרום התחתון (אזהרות/מקרא) התייצב — מונע גירעון-פיקסל
  return `${toolbar}
    <div class="board-main"><div class="board-canvas">${grid}</div>${drawer()}</div>
    ${results}${warnBar()}${guide}`;
}

// עדכון הדגשות חי בזמן הקלדה — בלי רינדור, כדי לא לאבד פוקוס בשדה. צובע את
// טקסט שמות הקבוצות (§7): זוג נבחר A/B מגנטה/כחול, חיפוש מרקר צהוב.
function applyHighlightsLive() {
  const q = teamQuery.toLowerCase();
  const pg = pickGame();
  document.querySelectorAll('.bc-team[data-team]').forEach(sp => {
    const id = sp.dataset.team;
    sp.classList.toggle('hl-a', (pg && id === pg.a) || (!pg && selTeam === id));
    sp.classList.toggle('hl-b', !!pg && id === pg.b);
    sp.classList.toggle('hl-search', !!q && (teamName(id) || '').toLowerCase().includes(q));
  });
  const c = document.getElementById('board-team-counter');
  if (c) {
    if (!q) { c.textContent = ''; c.classList.remove('no'); }
    else {
      const n = (L().games || []).filter(g => g.slot && ((teamName(g.a) || '').toLowerCase().includes(q) || (teamName(g.b) || '').toLowerCase().includes(q))).length;
      c.textContent = n ? `${n} משחקים מודגשים` : 'לא נמצאה קבוצה';
      c.classList.toggle('no', !n);
    }
  }
}

// ============================================================================
// כפתורי הלוח (board.*) — כל מטפל מנהל שמירה/רינדור בעצמו
// ============================================================================
const ACT = {};
ACT['board.view'] = el => { view = el.dataset.v; pick = null; boardRepaint(); return false; };
ACT['board.day']  = el => { boardDay = el.dataset.day; captureDayStart(boardDay); pick = null; boardRepaint(); return false; };
ACT['board.lock'] = el => { const g = X.findGame(el.dataset.game); if (g) { g.locked = !g.locked; commit(); } return false; };
ACT['board.rmBlock'] = el => { tryOp(() => { L().blocks = (L().blocks || []).filter(b => b.id !== el.dataset.id); return true; }); return false; };
ACT['board.clearSearch'] = () => { teamQuery = ''; boardRepaint(); return false; };
ACT['board.pickClear'] = () => { pick = null; boardRepaint(); return false; };
ACT['board.search'] = el => { teamQuery = el.value.trim(); boardRepaint(); return false; };   // blur — רינדור נקי
ACT['board.print'] = () => {
  window.open(`league-print.html?l=${encodeURIComponent(X.leagueId)}&day=${encodeURIComponent(boardDay || days()[0]?.id || '')}`, '_blank');
  return false;
};
ACT['board.undo'] = () => { if (!undoStack.length) return false; redoStack.push(snapshot()); restore(undoStack.pop()); commit(); return false; };
ACT['board.redo'] = () => { if (!redoStack.length) return false; undoStack.push(snapshot()); restore(redoStack.pop()); commit(); return false; };
// מסנן ליגה (§5)
ACT['board.league'] = el => { leagueFilter = el.dataset.cat || null; pick = null; boardRepaint(); return false; };
// §4: קישור-קבוצה מסרגל האזהרות — מדליק/מכבה את כל משחקי הקבוצה (selTeam → hl-a).
ACT['board.highlightTeam'] = el => { const t = el.dataset.team; selTeam = selTeam === t ? null : t; pick = null; boardRepaint(); return false; };
// §4: בחירת משחק-קופסה של הקבוצה → מציג לאן אפשר לשבצו (תאים מוארים).
ACT['board.pickBoxGame'] = el => { pick = { kind: 'game', id: el.dataset.game }; selTeam = null; boardRepaint(); return false; };
// מגבלת-מגרש: לחיצה על כותרת המגרש (בלוח) או שדה בהגדרות → שעת סיום למגרש.
ACT['board.netCutPrompt'] = el => {
  const day = el.dataset.day, net = +el.dataset.net;
  const cur = netCutOf(day, net) || '';
  const val = prompt(`${X.netName(net)} — זמין לשחק עד איזו שעה?\n(למשל 19:15 אם אין תאורה. ריק = בלי הגבלה.)`, cur);
  if (val === null) return false;
  const until = val.trim();
  if (until && !/^\d{1,2}:\d{2}$/.test(until)) { alert('שעה לא תקינה. פורמט HH:MM, למשל 19:15.'); return false; }
  setNetCut(day, net, until);
  return false;
};
// מהגדרות: שדה שעה (input) שמאציל לאותה לוגיקה. data-net/data-day, value = השעה.
ACT['board.netCutSet'] = el => {
  const until = (el.value || '').trim();
  if (until && !/^\d{1,2}:\d{2}$/.test(until)) return false;
  setNetCut(el.dataset.day, +el.dataset.net, until);
  return false;
};
// שחזור לתחילת הסשן — בעונה: כל הימים; ביום: היום הנוכחי (§9, מחזר dayStart).
function restoreDay(d) {
  const snap = dayStart[d]; if (!snap) return;
  // לעבור על ה**תמונה** (id→מיקום), לא על משחקי-היום הנוכחיים: בעונה גוררים משחקים
  // בין ימים (dragMove משנה g.day), ואז משחק שעבר מיום d כבר לא ב-gamesOf(d) —
  // המעבר על התמונה לפי id הוא היחיד שמחזיר אותו הביתה (כולל g.day). id יציב על פני
  // "תזמן מחדש" (finish() משמר את ה-id לפי key), אז כל id מופיע בתמונה של יום אחד.
  for (const [id, p] of snap.place) {
    const g = X.findGame(id);
    if (g) { g.day = d; g.slot = p.slot; g.net = p.net; g.locked = p.locked; }
  }
  L().blocks = (L().blocks || []).filter(b => b.day !== d).concat(clone(snap.blocks));
}
ACT['board.restore'] = () => {
  if (view === 'season') {
    if (!confirm('לשחזר את כל הימים לסידור שהיה בתחילת הסשן? רק המיקומים יוחזרו — תוצאות יישארו.')) return false;
    pushUndo(); for (const d of days()) restoreDay(d.id); commit(); return false;
  }
  const d = boardDay;
  if (!dayStart[d] || !confirm(`לשחזר את ${escLabel(d)} לסידור שהיה בתחילת היום? רק המיקומים יוחזרו — תוצאות יישארו.`)) return false;
  pushUndo(); restoreDay(d); commit(); return false;
};
ACT['board.reorderDay'] = () => {
  const d = boardDay;
  if (!confirm(`להריץ מחדש את המתזמן על ${escLabel(d)}? משחקים נעולים יישארו במקומם.`)) return false;
  pushUndo();
  try { const { games } = generateSeason(X.schedInput(), { phases: ['pack'], onlyDays: [d] }); L().games = games; }
  catch (e) { console.error(e); alert('הסידור נכשל: ' + e.message); restore(undoStack.pop()); boardRepaint(); return false; }
  commit(); return false;
};
// §8: תזמון מחדש של כל העונה (שומר נעצים). כמו reorderDay אבל בלי onlyDays —
// pack רץ על כל הימים, מכבד locked (§6.3), וה-id-ים נשמרים (finish() לפי key).
ACT['board.reorderSeason'] = () => {
  if (!confirm('לתזמן מחדש את כל העונה? המתזמן יסדר את כל הימים; משחקים נעולים 📌 יישארו במקומם.')) return false;
  pushUndo();
  try { const { games } = generateSeason(X.schedInput(), { phases: ['pack'] }); L().games = games; }
  catch (e) { console.error(e); alert('הסידור נכשל: ' + e.message); restore(undoStack.pop()); boardRepaint(); return false; }
  commit(); return false;
};
// §6.3: הוספת/הסרת סלוט ליום הנוכחי — משנה את boardDay.slots ב-meta.days (הפניה
// חיה מ-regularDays), queueSave שומר את המסמך כולו. שעת הסיום נגזרת מ-slots.
ACT['board.addSlot'] = () => {
  const d = dayById(boardDay);
  d.slots = Math.min(40, (d.slots || 16) + 1);
  applyNetCuts(boardDay);   // סלוט חדש אחרי מגבלת-מגרש → ייחסם (§ מגבלת-מגרש)
  commit(); return false;
};
ACT['board.removeSlot'] = () => {
  const d = dayById(boardDay);
  if ((d.slots || 0) <= 1) return false;
  const last = d.slots;
  // לא מסירים סלוט אחרון תפוס (משחק או חסימה ידנית). חסימות netcut של הסלוט הזה יוסרו עמו.
  if (gamesOf(boardDay).some(g => g.slot === last) ||
      blocksOf(boardDay).some(b => b.slot === last && b.kind !== 'netcut')) {
    alert('הסלוט האחרון תפוס — פני אותו לפני ההסרה.'); return false;
  }
  d.slots = last - 1;
  L().blocks = (L().blocks || []).filter(b => !(b.day === boardDay && b.slot === last));
  commit(); return false;
};
ACT['board.toggleWarns'] = () => { warnsOpen = !warnsOpen; boardRepaint(); return false; };
ACT['board.toggleResults'] = () => { resultsOpen = !resultsOpen; boardRepaint(); return false; };
// לחיצה על בעיה (§2+§4): קפיצה למקום בלוז, הבהוב, ו**בחירת המשחק הפוגע** —
// כך התאים הטובים להעברה נצבעים ירוק (אופציות), ואפשר להעביר בהקשה/גרירה.
ACT['board.gotoViol'] = el => {
  const v = realProblems()[+el.dataset.i]; if (!v) return false;
  // §6: בעונה נשארים בעונה ומדגישים שם — לא קופצים לתצוגת היום.
  if (view !== 'season') { boardDay = v.dayId; captureDayStart(boardDay); }
  const g = violGame(v);
  pick = g && g.slot ? { kind: 'game', id: g.id } : null;   // בחירת המשחק הפוגע → אפשרויות מוארות
  warnsOpen = true;
  boardRepaint();
  // §10: בלי טבעת-היקוף מהבהבת (חסימה אדומה נמנעת ממילא לפני שנוחתת). רק גלילה עדינה לתא.
  setTimeout(() => {
    const key = g && g.slot && g.net ? `${g.slot}|${g.net}` : (v.slot && v.net ? `${v.slot}|${v.net}` : null);
    const cell = key ? document.querySelector(`[data-cell="${key}"][data-day="${v.dayId}"]`) : null;
    if (cell) cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }, 90);
  return false;
};
ACT['board.fixViol'] = el => { fixViol(+el.dataset.i); return false; };

// ============================================================================
// מודל ההקשה — "בחירה → אפשרויות" בשני הכיוונים (§8.1 + בקשות המשתמשת)
// ============================================================================
function handleGameTap(id) {
  const g = X.findGame(id); if (!g) return;
  // תא-מטרה כבר נבחר → הצב את המשחק שם (מהקופסה או מהלוז)
  if (pick?.kind === 'cell') {
    const { day, slot, net } = pick;
    if (classifyPlacement(g, day, slot, net) === 'no') { pick = null; boardRepaint(); return; }
    pick = null;
    tryOp(() => dragMove(g, day, slot, net, { confirm: false }));
    return;
  }
  // משחק כבר נבחר
  if (pick?.kind === 'game') {
    if (pick.id === id) { pick = null; boardRepaint(); return; }   // ביטול בחירה
    const a = X.findGame(pick.id); pick = null;
    if (a) tryOp(() => swapGames(a, g));                            // הקשה-הקשה = החלפה
    return;
  }
  // בחירת המשחק (הדגשת שתי קבוצותיו)
  pick = { kind: 'game', id }; boardRepaint();
}

function handleCellTap(day, slot, net) {
  if (blockIndex(day).has(slot + '|' + net)) return;               // תא חסום
  if (cellIndex(day).get(slot + '|' + net)) return;                // תפוס — הכרטיס מטפל
  if (pick?.kind === 'game') {                                     // משחק נבחר → הצב כאן
    const g = X.findGame(pick.id); pick = null;
    if (g) tryOp(() => dragMove(g, day, slot, net, { confirm: false }));
    return;
  }
  // מיקוד/ביטול-מיקוד של תא פנוי → מציג את אפשרויות הקופסה
  if (pick?.kind === 'cell' && pick.day === day && pick.slot === slot && pick.net === net) pick = null;
  else pick = { kind: 'cell', day, slot, net };
  boardRepaint();
}

// ============================================================================
// Pointer Events — גרירה שעובדת גם במגע (§8.1). לא HTML5 drag.
// ============================================================================
let drag = null;
const TH = 7;

let tapPend = null;   // הקשה על תא פנוי / שם קבוצה (לא-גרירה) — מנוהלת דרך pointer,
                      // לא click, כדי לעבוד במגע בלי השהיה ובלי click מסונתז.

function attachListeners() {
  document.addEventListener('pointerdown', onDown, { passive: false });
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  // חיפוש חי — עדכון הדגשות בלי רינדור (שומר פוקוס בשדה)
  document.addEventListener('input', e => {
    const el = e.target.closest('#board-search'); if (!el) return;
    teamQuery = el.value.trim(); applyHighlightsLive();
  });
  window.addEventListener('resize', () => { if (onBoard()) fitGrid(); });
  // קיצורי מקלדת בטל/בצע-שוב (§10) — רק בעמוד הלוח וכשלא מקלידים בשדה.
  document.addEventListener('keydown', e => {
    if (!onBoard()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const key = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'z') {
      e.preventDefault();
      (e.shiftKey ? ACT['board.redo'] : ACT['board.undo'])();
    } else if ((e.metaKey || e.ctrlKey) && key === 'y') {
      e.preventDefault(); ACT['board.redo']();
    }
  });
}
// האם עמוד הלוח פעיל? (יש סרגל כלים של הלוח ב-DOM)
const onBoard = () => !!document.querySelector('.board-toolbar');

function onDown(e) {
  drag = null; tapPend = null;
  const el = e.target.closest('[data-drag]');
  if (el && !e.target.closest('button') && getComputedStyle(el).pointerEvents !== 'none') {   // 🚫 לא נגרר
    drag = { kind: el.dataset.drag, id: el.dataset.game, tile: el.dataset.kind, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, srcEl: el };
    return;
  }
  if (e.target.closest('button')) return;
  // הקשה על תא (פנוי) → מיקוד/הצבה
  const cell = e.target.closest('[data-cell]');
  if (cell) { tapPend = { startX: e.clientX, startY: e.clientY, day: cell.dataset.day, slot: +cell.dataset.cell.split('|')[0], net: +cell.dataset.cell.split('|')[1] }; return; }
  // §12: הקשה על הקופסה כשמשחק נבחר → הוצאה לקופסה
  if (pick?.kind === 'game' && e.target.closest('[data-boxdrop]')) tapPend = { startX: e.clientX, startY: e.clientY, box: true };
}

function onMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < TH) return;
  if (!drag.moved) {
    drag.moved = true; drag.ghost = makeGhost(drag);
    drag.srcEl.classList.add('dragging'); document.body.classList.add('board-dragging');
  }
  e.preventDefault();
  positionGhost(e.clientX, e.clientY);
  highlightUnder(e.clientX, e.clientY);
  updateAutoScroll(e.clientX, e.clientY);
}

function onUp(e) {
  if (drag) {
    const d = drag; drag = null;
    document.body.classList.remove('board-dragging');
    clearHighlight(); stopAutoScroll();
    if (!d.moved) { if (d.kind === 'game') handleGameTap(d.id); return; }   // הקשה על כרטיס
    if (d.ghost) d.ghost.remove();
    if (d.srcEl) d.srcEl.classList.remove('dragging');
    applyDrop(d, dropTarget(e.clientX, e.clientY));
    return;
  }
  if (tapPend) {
    const p = tapPend; tapPend = null;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TH) return;   // תזוזה = גלילה, לא הקשה
    if (p.box) {   // §12: הקשה על הקופסה כשמשחק נבחר → הוצאה
      const g = pickGame(); pick = null;
      if (g) tryOp(() => unassign(g)); else boardRepaint();
      return;
    }
    handleCellTap(p.day, p.slot, p.net);
  }
}

function dropTarget(x, y) {
  const el = document.elementFromPoint(x, y); if (!el) return null;
  const cell = el.closest('[data-cell]');
  if (cell) return { type: 'cell', day: cell.dataset.day, slot: +cell.dataset.cell.split('|')[0], net: +cell.dataset.cell.split('|')[1] };
  const dh = el.closest('[data-day-drop]'); if (dh) return { type: 'day', day: dh.dataset.dayDrop };
  if (el.closest('[data-drawer]')) return { type: 'drawer' };
  return null;
}

function applyDrop(d, drop) {
  if (!drop) return;
  if (d.kind === 'tile') { if (drop.type === 'cell') tryOp(() => dropTile(d.tile, drop.day, drop.slot, drop.net)); return; }
  const g = X.findGame(d.id); if (!g) return;
  if (drop.type === 'drawer') { tryOp(() => unassign(g)); return; }
  if (drop.type === 'day') {
    const spot = firstFree(drop.day);
    if (!spot) { alert('אין תא פנוי ביום הזה.'); return; }
    tryOp(() => dragMove(g, drop.day, spot.slot, spot.net));
    return;
  }
  if (drop.type === 'cell') tryOp(() => dragMove(g, drop.day, drop.slot, drop.net));
}

function firstFree(dayId) {
  const day = dayById(dayId), nets = netsOf(day), ci = cellIndex(dayId), bi = blockIndex(dayId);
  for (let s = 1; s <= day.slots; s++) for (const n of nets) { const k = s + '|' + n; if (!ci.get(k) && !bi.has(k)) return { slot: s, net: n }; }
  return null;
}

// ── רוח רפאים ──
function makeGhost(d) {
  const src = d.srcEl.cloneNode(true);
  src.querySelectorAll('button').forEach(b => b.remove());
  const g = document.createElement('div'); g.className = 'drag-ghost'; g.appendChild(src);
  document.body.appendChild(g);
  const r = d.srcEl.getBoundingClientRect();
  g.style.width = r.width + 'px'; d.gx = d.startX - r.left; d.gy = d.startY - r.top;
  return g;
}
function positionGhost(x, y) { if (drag?.ghost) { drag.ghost.style.left = (x - (drag.gx || 20)) + 'px'; drag.ghost.style.top = (y - (drag.gy || 20)) + 'px'; } }
let lastHi = null;
function highlightUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  const t = el?.closest('[data-cell]') || el?.closest('[data-day-drop]') || el?.closest('[data-drawer]');
  if (t === lastHi) return;
  if (lastHi) lastHi.classList.remove('drop-hi');
  if (t) t.classList.add('drop-hi');
  lastHi = t;
}
function clearHighlight() { if (lastHi) lastHi.classList.remove('drop-hi'); lastHi = null; }

// ── גלילה אוטומטית מבוססת-קרבה, ממשיכה כל עוד מחזיקים בקצה (dnd-kit style) ──
let autoRAF = null, autoVec = { el: null, x: 0, y: 0 };
function autoTick() {
  if (!drag || !autoVec.el || (!autoVec.x && !autoVec.y)) { autoRAF = null; return; }
  autoVec.el.scrollLeft += autoVec.x; autoVec.el.scrollTop += autoVec.y;
  autoRAF = requestAnimationFrame(autoTick);
}
function updateAutoScroll(cx, cy) {
  const el = document.elementFromPoint(cx, cy)?.closest('.board-scroll');
  if (!el) { autoVec = { el: null, x: 0, y: 0 }; return; }
  const r = el.getBoundingClientRect();
  const zx = Math.min(90, r.width * 0.18), zy = Math.min(90, r.height * 0.18), MAX = 20;
  let x = 0, y = 0;
  if (el.classList.contains('hscroll')) {
    if (cx < r.left + zx) x = -MAX * (1 - (cx - r.left) / zx);
    else if (cx > r.right - zx) x = MAX * (1 - (r.right - cx) / zx);
  }
  if (cy < r.top + zy) y = -MAX * (1 - (cy - r.top) / zy);
  else if (cy > r.bottom - zy) y = MAX * (1 - (r.bottom - cy) / zy);
  autoVec = { el, x: Math.round(x), y: Math.round(y) };
  if (!autoRAF && (autoVec.x || autoVec.y)) autoRAF = requestAnimationFrame(autoTick);
}
function stopAutoScroll() { autoVec = { el: null, x: 0, y: 0 }; if (autoRAF) { cancelAnimationFrame(autoRAF); autoRAF = null; } }

export default { init, render, ACT };
