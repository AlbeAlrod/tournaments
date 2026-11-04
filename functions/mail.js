// Emails to players (secure tournaments only) and to the super-admin.
// SMTP_URL (secret) is any SMTP URL, e.g. smtps://user:app-password@smtp.gmail.com:465.
// Without a real URL nothing is sent; every mail is still recorded in mailLog (server-only).
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

const SMTP_URL = defineSecret('SMTP_URL');
const MAIL_FROM = defineString('MAIL_FROM', { default: 'auto' });
const SITE_URL = defineString('SITE_URL', { default: 'https://albealrod.github.io/tournaments' });
const SUPER_EMAIL = defineString('SUPER_EMAIL', { default: 'none' });

let transport;
export async function sendMail(to, subject, html, meta) {
  const url = SMTP_URL.value();
  const live = /^smtps?:\/\//.test(url);
  if (live) {
    transport ??= nodemailer.createTransport(url);
    await transport.sendMail({ from: MAIL_FROM.value().includes('@') ? MAIL_FROM.value() : undefined, to, subject, html });
  }
  await getFirestore().collection('mailLog').add({ to, subject, ...meta, sent: live, at: FieldValue.serverTimestamp() });
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const onColor = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#000000' : '#FFFFFF';
};
const fmtWhen = ms => new Date(ms).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' }) : '';

export function mailHtml(t, club, lines, cta) {
  const color = /^#[0-9a-f]{6}$/i.test(club?.brand?.primary || '') ? club.brand.primary : '#652d92';
  return `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111111">
<div style="height:6px;background:${color}"></div>
<h2 style="margin:20px 0 4px;font-size:22px">${esc(t.meta?.name)}</h2>
<p style="color:#555555;margin:0 0 16px">${esc(club?.name || '')}${t.meta?.eventDate ? ' · ' + esc(fmtDay(t.meta.eventDate)) : ''}${t.meta?.venue ? ' · ' + esc(t.meta.venue) : ''}</p>
${lines.map(l => `<p style="font-size:16px;line-height:1.6;margin:0 0 12px">${l}</p>`).join('\n')}
${cta ? `<p style="margin:20px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:${color};color:${onColor(color)};padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold">${esc(cta.label)}</a></p>` : ''}
</div>`;
}

const tLink = id => `${SITE_URL.value().replace(/\/$/, '')}/index.html?t=${encodeURIComponent(id)}`;
const payLink = t => /^https?:\/\//i.test(t.meta?.paymentLink || '') ? t.meta.paymentLink
  : t.meta?.paymentLink ? 'https://' + t.meta.paymentLink : '';

// What a registration change means for the pair: [kind, subject, lines, cta] or null.
export function regMessage(kind, t, r, tId) {
  const pair = `<b>${esc(r.p1)}</b> ו<b>${esc(r.p2)}</b>`;
  const cat = esc((t.categories || []).find(c => c.id === r.category)?.name || '');
  const view = { url: tLink(tId), label: 'לדף הטורניר' };
  const pay = payLink(t) ? { url: payLink(t), label: 'לתשלום' } : view;
  const by = r.payDeadline ? ` עד <b>${esc(fmtWhen(r.payDeadline))}</b>` : '';
  switch (kind) {
    case 'received': return ['קיבלנו את ההרשמה', [`ההרשמה של ${pair} לקטגוריה ${cat} התקבלה.`, 'היא ממתינה לאישור המנהל, ונעדכן אתכם כאן במייל. אין צורך לשלם עדיין.'], view];
    case 'waitlist': return ['נרשמתם לרשימת ההמתנה', [`הקטגוריה ${cat} מלאה, ולכן ${pair} ברשימת ההמתנה.`, 'אם יתפנה מקום נעדכן אתכם, ורק אז תתבקשו לשלם.'], view];
    case 'approved': return ['אושרתם לטורניר', [`ההרשמה של ${pair} לקטגוריה ${cat} אושרה.`, `כדי לשמור על המקום יש לשלם${by}. אחרי המועד המקום עשוי לעבור לזוג הבא בתור.`], pay];
    case 'promoted': return ['התפנה מקום ואושרתם', [`התפנה מקום בקטגוריה ${cat}, ו${pair} אושרו!`, `כדי לשמור על המקום יש לשלם${by}.`], pay];
    case 'backToWait': return ['עברתם לרשימת ההמתנה', [`ההרשמה של ${pair} עברה לרשימת ההמתנה בקטגוריה ${cat}.`, 'אם שילמתם ויש טעות, ענו למייל הזה או פנו למארגנים.'], view];
    case 'rejected': return ['ההרשמה לא אושרה', [`לצערנו ההרשמה של ${pair} לקטגוריה ${cat} לא אושרה.`, 'לשאלות אפשר לפנות למארגנים.'], view];
    case 'paid': return ['התשלום התקבל, אתם רשומים', [`התשלום של ${pair} התקבל, ואתם רשומים לטורניר בקטגוריה ${cat}.`, 'נתראה במגרש!'], view];
    default: return null;
  }
}

export function regEvent(before, after) {
  if (!before) return after.status === 'waitlist' ? 'waitlist' : 'received';
  if (before.status !== after.status) {
    if (after.status === 'approved') return before.status === 'waitlist' ? 'promoted' : 'approved';
    if (after.status === 'waitlist') return 'backToWait';
    if (after.status === 'rejected') return 'rejected';
    return null;
  }
  return !before.paid && after.paid ? 'paid' : null;
}

async function mailForRegistration(ev, before, after) {
  const kind = after && regEvent(before, after);
  if (!kind) return;
  const { tId, rId } = ev.params;
  const db = getFirestore();
  const t = (await db.doc(`tournaments/${tId}`).get()).data();
  if (t?.secure !== true) return;
  const email = (await db.doc(`tournaments/${tId}/registrations/${rId}/private/contact`).get()).data()?.email;
  if (!email) return;
  const club = (await db.doc(`clubs/${t.clubId}`).get()).data();
  const [subject, lines, cta] = regMessage(kind, t, after, tId);
  await sendMail(email, `${subject} · ${t.meta?.name || ''}`, mailHtml(t, club, lines, cta), { kind, tId, rId });
}

const opts = { document: 'tournaments/{tId}/registrations/{rId}', secrets: [SMTP_URL] };
export const mailOnRegistrationCreated = onDocumentCreated(opts, ev => mailForRegistration(ev, null, ev.data?.data()));
export const mailOnRegistrationUpdated = onDocumentUpdated(opts, ev => mailForRegistration(ev, ev.data?.before.data(), ev.data?.after.data()));

// A new secure tournament waits for the super-admin: tell them.
export const mailOnTournamentCreated = onDocumentCreated({ document: 'tournaments/{tId}', secrets: [SMTP_URL] }, async ev => {
  const t = ev.data?.data();
  if (t?.secure !== true || t.approval !== 'pending' || !SUPER_EMAIL.value().includes('@')) return;
  const club = (await getFirestore().doc(`clubs/${t.clubId}`).get()).data();
  const html = mailHtml(t, club, [`טורניר חדש של ${esc(club?.name || t.clubId)} ממתין לאישור שלך.`],
    { url: `${SITE_URL.value().replace(/\/$/, '')}/club.html`, label: 'לאישור בפאנל' });
  await sendMail(SUPER_EMAIL.value(), `טורניר חדש ממתין לאישור · ${t.meta?.name || ''}`, html, { kind: 'pendingTournament', tId: ev.params.tId });
});
