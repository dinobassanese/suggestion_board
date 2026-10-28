// ============================================================================
// digest.js — the DAILY SUMMARY EMAIL
// ----------------------------------------------------------------------------
// Once a day (at DIGEST_HOUR, in your DIGEST_TIMEZONE) this sends you ONE email
// that says what happened on the board since the last summary:
//   • new ideas (including ones still waiting for your approval)
//   • new votes and comments
//   • how many items are waiting for approval
//   • the 5 most-requested ideas right now
// On quiet days (nothing new) it sends nothing.
//
// It is switched on only when the email settings below exist (see README).
//
// How it works, in plain terms:
//   1. A tiny timer wakes up once a minute and asks "is it time yet?"
//   2. If it's time and nothing was sent today, it builds the email and sends it.
//   3. It remembers the day it last sent (in the database), so a restart of the
//      app can never cause a second email on the same day.
// ============================================================================

const nodemailer = require('nodemailer');
const { db, getSetting, setSetting } = require('./db');
const { loadBrand } = require('./brand');

// Your brand's name and colors, so the email matches your board.
const brand = loadBrand();

// ---- Settings (all come from environment variables / your .env file) -------
function readConfig(env = process.env) {
  const hour = Number(env.DIGEST_HOUR ?? 8);
  return {
    // Option A (works on Railway): send through Resend's web service. Needs a Resend API key.
    resendKey: (env.RESEND_API_KEY || '').trim(),
    // Option B: send through any email account's SMTP server (some hosts block this).
    host: (env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT || 587),
    user: (env.SMTP_USER || '').trim(),
    pass: env.SMTP_PASS || '',
    from: (env.DIGEST_FROM || env.SMTP_USER || '').trim(),   // with Resend this must be an address on your verified domain
    to: (env.DIGEST_TO || '').split(',').map((a) => a.trim()).filter(Boolean),
    // Which hour of the day (0-23) to send, in the time zone below.
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    timeZone: (env.DIGEST_TIMEZONE || 'UTC').trim(),
    // The web address of your board, used for the "open dashboard" link.
    publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  };
}

// What is missing? An empty list means the email is fully set up.
function missingSettings(config) {
  const missing = [];
  if (config.resendKey) {
    // Resend mode: needs the key, a "from" address, and who to send to.
    if (!config.from) missing.push('DIGEST_FROM');
  } else {
    if (!config.host) missing.push('SMTP_HOST');
    if (!config.user) missing.push('SMTP_USER');
    if (!config.pass) missing.push('SMTP_PASS');
  }
  if (config.to.length === 0) missing.push('DIGEST_TO');
  return missing;
}

function isValidTimeZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

// The date and hour right now in the chosen time zone, e.g. { day: '2026-10-09', hour: 8 }.
function localDayAndHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

// ---- Text safety ------------------------------------------------------------
// Customers type the ideas, so before putting their words in an HTML email we
// turn characters like < and & into harmless text (otherwise someone could
// sneak a link or script into YOUR inbox).
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Keep plain-text lines on one line, and short.
function oneLine(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---- Build the email --------------------------------------------------------
// `since` is a UTC time string like '2026-10-08 08:00:00' (how the database stores times).
// Returns null on a quiet day, otherwise { subject, text, html, counts }.
function buildDigest({ since, publicUrl = '', limit = 15 }) {
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const newIdeas = db.prepare(`
    SELECT i.id, i.title, i.description, i.author_name, i.approved, c.name AS category,
           (SELECT COUNT(*) FROM votes v WHERE v.idea_id = i.id) AS votes
    FROM ideas i LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.created_at > ? ORDER BY i.created_at DESC, i.id DESC`).all(since);
  const newVotes = count(
    `SELECT COUNT(*) AS n FROM votes v JOIN ideas i ON i.id = v.idea_id
     WHERE v.created_at > ? AND i.approved = 1 AND i.created_at <= ?`, since, since);
  const newComments = count(
    `SELECT COUNT(*) AS n FROM comments WHERE created_at > ? AND is_admin = 0`, since);

  if (newIdeas.length === 0 && newVotes === 0 && newComments === 0) return null;

  const waitingIdeas = count('SELECT COUNT(*) AS n FROM ideas WHERE approved = 0');
  const waitingComments = count('SELECT COUNT(*) AS n FROM comments WHERE approved = 0');
  const waiting = waitingIdeas + waitingComments;
  const top = db.prepare(`
    SELECT i.id, i.title, MAX(0, COUNT(v.id) + i.vote_adjustment) AS votes
    FROM ideas i LEFT JOIN votes v ON v.idea_id = i.id
    WHERE i.approved = 1 GROUP BY i.id ORDER BY votes DESC, i.created_at DESC, i.id DESC LIMIT 5`).all();

  const shown = newIdeas.slice(0, limit);
  const more = newIdeas.length - shown.length;
  const dashboard = publicUrl ? `${publicUrl}/admin.html` : '';

  const counts = {
    newIdeas: newIdeas.length, newVotes, newComments, waiting,
  };
  const subject = `Feature board: ${newIdeas.length} new idea${newIdeas.length === 1 ? '' : 's'}`
    + `${waiting ? `, ${waiting} waiting for approval` : ''}`;

  // Plain-text version (shown by email apps that don't display formatting).
  const lines = [
    'Here is what happened on your feature board since the last summary.', '',
    `New ideas: ${newIdeas.length}`, `New votes on existing ideas: ${newVotes}`, `New comments: ${newComments}`,
    `Waiting for your approval: ${waiting}`, '',
  ];
  if (shown.length) {
    lines.push('NEW IDEAS');
    for (const i of shown) {
      lines.push(`- ${oneLine(i.title)} (${oneLine(i.author_name, 40)}${i.category ? `, ${oneLine(i.category, 40)}` : ''})`
        + `${i.approved ? '' : ' [WAITING FOR APPROVAL]'}`);
    }
    if (more > 0) lines.push(`...and ${more} more`);
    lines.push('');
  }
  lines.push('MOST REQUESTED RIGHT NOW');
  top.forEach((t, n) => lines.push(`${n + 1}. ${oneLine(t.title)} - ${t.votes} vote${t.votes === 1 ? '' : 's'}`));
  if (dashboard) lines.push('', `Open your dashboard: ${dashboard}`);
  const text = lines.join('\n');

  // HTML version (what most people see).
  const stat = (n, label) => `<td style="padding:8px 14px;text-align:center"><div style="font-size:24px;font-weight:700;color:${brand.colors.action}">${n}</div><div style="font-size:12px;color:#777">${label}</div></td>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f7;font-family:'${brand.fonts.body}',Arial,sans-serif;color:#555">
<div style="max-width:620px;margin:0 auto;padding:20px">
<div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:20px">
<h1 style="font-size:20px;margin:0 0 4px;color:${brand.colors.action}">${esc(brand.name)} Feature Board Summary</h1>
<p style="margin:0 0 14px;color:#777;font-size:13px">Since the last summary</p>
<table role="presentation" style="border-collapse:collapse;margin-bottom:14px"><tr>
${stat(newIdeas.length, 'New ideas')}${stat(newVotes, 'New votes')}${stat(newComments, 'New comments')}${stat(waiting, 'Waiting for approval')}
</tr></table>
${shown.length ? `<h2 style="font-size:15px;margin:16px 0 6px">New Ideas</h2><ul style="padding-left:18px;margin:0">${shown.map((i) => `
<li style="margin-bottom:6px"><strong>${esc(oneLine(i.title))}</strong>${i.approved ? '' : ' <span style="background:#fff3cd;color:#8a6d3b;border-radius:5px;padding:1px 6px;font-size:12px">Waiting for approval</span>'}<br>
<span style="font-size:13px;color:#777">${esc(oneLine(i.author_name, 40))}${i.category ? ` · ${esc(oneLine(i.category, 40))}` : ''}</span></li>`).join('')}</ul>${more > 0 ? `<p style="font-size:13px;color:#777">…and ${more} more</p>` : ''}` : ''}
<h2 style="font-size:15px;margin:16px 0 6px">Most Requested Right Now</h2>
<ol style="padding-left:18px;margin:0">${top.map((t) => `<li style="margin-bottom:4px">${esc(oneLine(t.title))} <span style="color:#777">· ${t.votes} vote${t.votes === 1 ? '' : 's'}</span></li>`).join('')}</ol>
${dashboard ? `<p style="margin:20px 0 0"><a href="${esc(dashboard)}" style="background:${brand.colors.action};color:${brand.onAction};text-decoration:none;border-radius:5px;padding:9px 16px;display:inline-block;font-weight:600">Open Dashboard</a></p>` : ''}
</div></div></body></html>`;

  return { subject, text, html, counts };
}

// ---- Send it ----------------------------------------------------------------
// Resend sends email through an ordinary web request (HTTPS), which hosts like Railway allow.
// It offers the same sendMail(...) function as the SMTP sender below, so the rest of
// the code doesn't care which one is used.
function createResendTransport(config) {
  return {
    async sendMail(mail) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: mail.from,
          to: String(mail.to).split(',').map((a) => a.trim()).filter(Boolean),
          subject: mail.subject, text: mail.text, html: mail.html,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        // Resend explains problems in plain words, e.g. "The domain is not verified".
        let detail = '';
        try { detail = (await response.json()).message || ''; } catch { /* no details */ }
        throw new Error(`Resend refused the email (${response.status})${detail ? ': ' + detail : ''}`);
      }
    },
  };
}

function createTransport(config) {
  if (config.resendKey) return createResendTransport(config);
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,     // 465 = encrypted from the start; 587 upgrades to encrypted
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
}

// Build and send one summary. Returns { sent, reason?, counts? }.
// `now` and `transport` can be swapped in by the tests.
async function sendDigest({ config = readConfig(), transport, now = new Date(), force = false } = {}) {
  const missing = missingSettings(config);
  if (missing.length) return { sent: false, reason: `missing settings: ${missing.join(', ')}` };

  // "Since" = the last time a summary went out, or the last 24 hours the very first time.
  // A test send (force) looks back 7 days so you have something to see.
  const lastSent = getSetting('digest_last_sent_at');
  const fallback = new Date(now.getTime() - (force ? 7 : 1) * 24 * 60 * 60 * 1000);
  const since = (lastSent && !force ? new Date(lastSent) : fallback).toISOString().slice(0, 19).replace('T', ' ');

  const digest = buildDigest({ since, publicUrl: config.publicUrl });
  if (!digest) return { sent: false, reason: 'nothing new' };

  await (transport || createTransport(config)).sendMail({
    from: config.from, to: config.to.join(', '), subject: digest.subject, text: digest.text, html: digest.html,
  });
  return { sent: true, counts: digest.counts };
}

// ---- The daily timer --------------------------------------------------------
// Checks once a minute. Sends at most once per local day, at or after DIGEST_HOUR.
async function checkSchedule({ config = readConfig(), transport, now = new Date(), log = console } = {}) {
  if (missingSettings(config).length) return { ran: false };
  const { day, hour } = localDayAndHour(now, config.timeZone);
  if (hour < config.hour) return { ran: false };
  if (getSetting('digest_last_day') === day) return { ran: false };

  // The very first time, remember "24 hours ago" as the starting point, so that if the first
  // send fails, the next day's email still covers these ideas.
  if (!getSetting('digest_last_sent_at')) {
    setSetting('digest_last_sent_at', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  }
  // Mark the day FIRST, so a slow or failing send can't make a second email the same day.
  setSetting('digest_last_day', day);
  try {
    const result = await sendDigest({ config, transport, now });
    if (result.sent) {
      setSetting('digest_last_sent_at', now.toISOString());
      log.log(`Daily summary emailed to ${config.to.join(', ')} (${result.counts.newIdeas} new ideas).`);
    } else {
      log.log(`Daily summary skipped: ${result.reason}.`);
    }
    return { ran: true, ...result };
  } catch (err) {
    // The day stays marked, so a broken email setup is tried once a day, not every minute.
    // The next successful summary still covers everything since the last one that was sent.
    log.error('Daily summary could not be sent:', err.message);
    return { ran: true, sent: false, reason: 'send failed', error: err.message };
  }
}

function startDigestTimer(log = console) {
  const config = readConfig();
  const missing = missingSettings(config);
  if (missing.length) {
    log.log('Daily summary email: off (see README to switch it on)');
    return null;
  }
  if (!isValidTimeZone(config.timeZone)) {
    log.error(`Daily summary email: DIGEST_TIMEZONE "${config.timeZone}" is not a valid time zone (example: America/Toronto). Email is off.`);
    return null;
  }
  log.log(`Daily summary email: on, sends around ${config.hour}:00 (${config.timeZone}) to ${config.to.join(', ')}`);
  const timer = setInterval(() => { checkSchedule({ config }).catch(() => {}); }, 60 * 1000);
  timer.unref();           // don't keep the program alive just for this timer
  checkSchedule({ config }).catch(() => {});
  return timer;
}

module.exports = {
  createResendTransport, readConfig, missingSettings, isValidTimeZone, localDayAndHour, buildDigest,
  sendDigest, checkSchedule, startDigestTimer,
};
