// ============================================================================
// security.js — PROTECTION against spam, bots and attacks
// ----------------------------------------------------------------------------
// Everything that keeps the board safe lives here, so it's easy to review:
//
//   1. rateLimit()        – caps how many requests one visitor can make
//   2. checkHuman()       – catches bots (hidden trap field, form timing,
//                           and optionally Cloudflare's "Verify you are human")
//   3. looksLikeSpam()    – spots posts containing web links
//   4. securityHeaders()  – tells browsers to apply extra safety rules
//   5. hashIp()           – scrambles IP addresses before we store them
// ============================================================================

const crypto = require('crypto');
const { db, getSetting } = require('./db');

// A random secret created on first run and kept in the database (see db.js).
// It's used to scramble IP addresses and to "sign" form tokens so they can't be faked.
const SECRET = getSetting('secret');

// ----------------------------------------------------------------------------
// 5. Scrambled IP addresses
// ----------------------------------------------------------------------------
// We never store raw IP addresses (they're personal data). Instead we store a
// "hash": a fingerprint that's always the same for the same IP but can't be
// reversed. Good enough to notice "40 votes came from one network".
function hashIp(ip) {
  return crypto.createHash('sha256').update(SECRET + String(ip)).digest('hex').slice(0, 16);
}

// ----------------------------------------------------------------------------
// 1. Rate limiting (spam limits)
// ----------------------------------------------------------------------------
// Time is split into fixed windows (e.g. 10-minute blocks). For each visitor
// we count requests in the current block; over the limit = "429 Too many requests".
// Counters live in the database, so restarting the server doesn't reset them,
// and old counters are deleted regularly so they can't pile up.
const bump = db.prepare(`
  INSERT INTO rate_limits (bucket, key, window_start, count) VALUES (?, ?, ?, 1)
  ON CONFLICT(bucket, key, window_start) DO UPDATE SET count = count + 1
  RETURNING count
`);

function rateLimit({ bucket, max, windowMs, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const { count } = bump.get(bucket, hashIp(req.ip), windowStart);
    if (count > max) {
      // Tell well-behaved clients how many seconds to wait.
      res.setHeader('Retry-After', Math.ceil((windowStart + windowMs - now) / 1000));
      return res.status(429).json({
        error: message || 'Too many requests. Please wait a few minutes and try again.',
      });
    }
    next();
  };
}

// Every 10 minutes, delete counters older than 2 hours (our longest window is 1 hour).
// .unref() means "don't keep the program alive just for this timer".
setInterval(() => {
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(Date.now() - 2 * 60 * 60 * 1000);
}, 10 * 60 * 1000).unref();

const MIN = 60 * 1000;
const limits = {
  // Page data: loading the list, opening an idea, searching. Generous, because
  // everyone in one office can share a single IP address.
  read: rateLimit({ bucket: 'read', max: 1200, windowMs: 5 * MIN }),
  // The "already suggested?" check runs as people type, and costs the most work.
  similar: rateLimit({ bucket: 'similar', max: 60, windowMs: MIN }),
  // Any change: posting, voting, commenting.
  write: rateLimit({ bucket: 'write', max: 120, windowMs: 10 * MIN }),
  // New ideas + comments specifically.
  post: rateLimit({ bucket: 'post', max: 30, windowMs: 60 * MIN,
    message: 'You\'ve posted a lot in the last hour. Please try again later.' }),
  // Votes from one network per hour (slows down vote-stuffing).
  vote: rateLimit({ bucket: 'vote', max: 100, windowMs: 60 * MIN,
    message: 'Too many votes from your network in the last hour. Please try again later.' }),
  // Admin password attempts.
  login: rateLimit({ bucket: 'login', max: 10, windowMs: 15 * MIN,
    message: 'Too many login attempts. Wait 15 minutes and try again.' }),
};

// ----------------------------------------------------------------------------
// 2. Bot checks
// ----------------------------------------------------------------------------
// a) FORM TOKEN. When the board page loads, the server hands it a token that
//    contains the time and a signature only this server can make. Every post,
//    vote and comment must send it back. This blocks the simplest bots, which
//    skip the page and fire requests straight at the server, and the token's
//    time lets us reject anything submitted inhumanly fast.
const MIN_FILL_MS = 2000;                      // humans take at least 2 seconds
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * MIN;    // tokens last a week

function sign(text) {
  return crypto.createHmac('sha256', SECRET).update(text).digest('hex').slice(0, 32);
}
function makeFormToken() {
  const issued = String(Date.now());
  return `${issued}.${sign(issued)}`;
}
function checkFormToken(token) {
  const [issued, signature] = String(token || '').split('.');
  // Only plain digits + 32 hex characters are valid (also stops odd characters crashing the compare below).
  if (!/^\d{1,15}$/.test(issued || '') || !/^[0-9a-f]{32}$/.test(signature || '')) return 'invalid';
  const expected = sign(issued);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return 'invalid';
  const age = Date.now() - Number(issued);
  if (age < MIN_FILL_MS) return 'too_fast';
  if (age > TOKEN_MAX_AGE_MS) return 'expired';
  return 'ok';
}

// b) HONEYPOT. Each form has a hidden field called "website" that people can't
//    see, so they leave it empty. Bots fill in every field they find.

// c) CLOUDFLARE TURNSTILE (optional). A free "Verify you are human" check that
//    is usually invisible. Turned on only when you set both
//    TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (see README).
// .trim() removes stray spaces or line breaks that can sneak in when pasting a key.
const TURNSTILE_SITE_KEY = (process.env.TURNSTILE_SITE_KEY || '').trim();
const TURNSTILE_SECRET_KEY = (process.env.TURNSTILE_SECRET_KEY || '').trim();
const turnstileEnabled = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

async function verifyTurnstile(token, ip) {
  if (!token) {
    // No token at all usually means the check never appeared in the visitor's browser
    // (blocked script, or this website address is missing from the widget's Hostnames).
    console.warn('Turnstile: the form was sent without a check result (the widget did not load or was not completed).');
    return false;
  }
  try {
    // Ask Cloudflare whether this token is genuine (tokens work once, for 5 minutes).
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: String(token), remoteip: ip }),
      signal: AbortSignal.timeout(8000), // give up after 8 seconds
    });
    const result = await response.json();
    if (result.success !== true) {
      // Cloudflare says WHY, e.g. "invalid-input-secret" (wrong secret key, or the secret
      // belongs to a different widget than the site key) or "timeout-or-duplicate".
      console.warn('Turnstile check failed:', (result['error-codes'] || []).join(', ') || 'no reason given');
    }
    return result.success === true;
  } catch (err) {
    console.warn('Turnstile: could not reach Cloudflare to verify:', err.message);
    return false; // Cloudflare unreachable → treat as not verified
  }
}

/**
 * Run all bot checks on a request. Returns an error message, or null if it looks human.
 * @param {boolean} withTurnstile  also require the Turnstile check (for posts/comments)
 */
async function checkHuman(req, { withTurnstile = false } = {}) {
  if (req.body.website) return 'We couldn\'t accept that. Please refresh the page and try again.';
  const token = checkFormToken(req.body.form_token);
  if (token === 'too_fast') return 'That was very quick. Wait a moment and try again.';
  if (token === 'expired') return 'This page has been open a long time. Refresh it and try again.';
  if (token !== 'ok') return 'Please refresh the page and try again.';
  if (withTurnstile && turnstileEnabled && !(await verifyTurnstile(req.body.turnstile_token, req.ip))) {
    return 'Please complete the "Verify you are human" check and try again.';
  }
  return null;
}

// ----------------------------------------------------------------------------
// 3. Link detection
// ----------------------------------------------------------------------------
// Spam almost always contains web links, real feature requests rarely do.
// Posts with links are held for your review even when reviewing is switched off.
function looksLikeSpam(...texts) {
  const text = texts.join(' ');
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ru|xyz|info|biz|top|site|online|shop)\b)/i.test(text);
}

// ----------------------------------------------------------------------------
// 4. Security headers
// ----------------------------------------------------------------------------
// Extra instructions sent with every page that tell the browser what is allowed:
//  • Content-Security-Policy: only run scripts from our own site (and Cloudflare's
//    bot check). Even if someone slipped code into the page, the browser refuses it.
//  • frame-ancestors / X-Frame-Options: which websites may show our pages inside
//    an <iframe>. The admin dashboard: nobody (stops "clickjacking", where a
//    hidden copy of your dashboard is overlaid on another site to trick clicks).
//  • X-Content-Type-Options: don't let the browser guess file types.
//  • Strict-Transport-Security: always use the secure https:// address.
//
// EMBED_ALLOWED_SITES: the websites allowed to embed the public board, separated
// by spaces, e.g. "https://www.yourcompany.com https://yourcompany.com".
// If you don't set it, any site may embed the board (the dashboard is always protected).
const EMBED_ALLOWED_SITES = (process.env.EMBED_ALLOWED_SITES || '').trim();

function securityHeaders(req, res, next) {
  const isAdmin = req.path.startsWith('/admin') || req.path.startsWith('/api/admin');
  const frameAncestors = isAdmin ? "'none'" : (EMBED_ALLOWED_SITES ? `'self' ${EMBED_ALLOWED_SITES}` : '*');

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; '));
  if (isAdmin) {
    res.setHeader('X-Frame-Options', 'DENY');         // older browsers' version of frame-ancestors
    res.setHeader('Cache-Control', 'no-store');        // don't keep admin data in caches
    res.setHeader('X-Robots-Tag', 'noindex');          // keep it out of search engines
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

module.exports = {
  hashIp, limits, makeFormToken, checkHuman, looksLikeSpam, securityHeaders,
  turnstileSiteKey: turnstileEnabled ? TURNSTILE_SITE_KEY : '',
};
