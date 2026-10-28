// ============================================================================
// server.js — the WEB SERVER (the "back end")
// ----------------------------------------------------------------------------
// This is the program that runs on your hosting service. It does two jobs:
//
//   1. Serves the web pages in the /public folder (what people see).
//   2. Answers "API" requests: small messages the pages send to save or load
//      data, e.g. "here's a new idea, please store it" or "give me all ideas".
//
// We use Express, the most popular Node.js library for building web servers.
// Each `app.get(...)` / `app.post(...)` below is a "route": a URL the server
// knows how to answer.
//
//   GET    = read something         POST   = create something
//   PATCH  = change something       DELETE = remove something
//
// Routes starting with /api/admin/ are locked behind your admin password.
// Spam limits, bot checks and security headers come from security.js.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, STATUSES, getSetting, setSetting } = require('./db');
const { findSimilar, prepareIdea } = require('./similarity');
const digest = require('./digest');
const { loadBrand, renderPage } = require('./brand');
const {
  hashIp, limits, makeFormToken, checkHuman, looksLikeSpam, securityHeaders, turnstileSiteKey,
} = require('./security');

const app = express();
const PORT = process.env.PORT || 3000;

// Your admin password comes from an "environment variable" (a setting you
// give the server when it starts — see README). Never hard-code real passwords.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD is not set — using "changeme". Set a real password before going live!');
}

// Hosting services put the app behind a "proxy" (a middleman server). This
// setting says how many proxies to trust when working out a visitor's real IP
// address, which the spam limits depend on. 1 is right for most hosts; if you
// put Cloudflare in front of your host, set TRUST_PROXY=2. (See README.)
const trustProxy = (process.env.TRUST_PROXY || '1').trim();   // empty/unset = 1
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'false' ? false : trustProxy);

app.disable('x-powered-by');           // don't advertise which software we run
app.use(securityHeaders);              // extra browser safety rules (security.js)
app.use(express.json({ limit: '20kb' })); // read JSON from the pages; reject anything huge

// ----------------------------------------------------------------------------
// Branding (name, colors, fonts, logo, wording). Read once at startup from the
// branding folder; change brand.json, then restart the app. See brand.js.
// ----------------------------------------------------------------------------
const brand = loadBrand();
brand.warnings.forEach((w) => console.warn('⚠️  Branding: ' + w));

// The two pages are templates: {{placeholders}} are filled in with your brand.
// These routes come BEFORE the static files so the raw templates never go out.
const readTemplate = (file) => fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
const pages = {
  index: renderPage(readTemplate('index.html'), brand, { pageTitle: brand.productName }),
  admin: renderPage(readTemplate('admin.html'), brand, { pageTitle: 'Suggestions Dashboard' }),
};
const sendPage = (html) => (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(html); };
app.get(['/', '/index.html'], sendPage(pages.index));
app.get('/admin.html', sendPage(pages.admin));

// The colors and fonts, as a small stylesheet built from brand.json.
app.get('/brand.css', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('css').send(brand.css); });

// Files from the branding folder: the logo, the tab icons, optional custom.css
// and font files. Only picture, font and stylesheet files are served: never
// brand.json or anything else that might be in that folder.
const BRAND_PUBLIC = /\.(svg|png|jpe?g|webp|gif|ico|css|woff2?|ttf|otf)$/i;
app.use('/brand', (req, res, next) => (BRAND_PUBLIC.test(req.path) ? next() : res.status(404).end()),
  express.static(brand.dir, { index: false, dotfiles: 'ignore', maxAge: '1h' }));
// Browsers ask for the tab icons at fixed addresses.
const iconRoutes = { '/favicon.svg': 'svg', '/favicon.png': 'png', '/favicon.ico': 'ico', '/apple-touch-icon.png': 'apple' };
for (const [url, key] of Object.entries(iconRoutes)) {
  app.get(url, (req, res) => (brand.icons[key]
    ? res.sendFile(path.join(brand.dir, brand.icons[key]), { maxAge: '1h' })
    : res.status(404).end()));
}

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Spam limit on reading data (page loads, searches). Admin pages are excluded.
app.use('/api', (req, res, next) =>
  req.method === 'GET' && !req.path.startsWith('/admin') ? limits.read(req, res, next) : next());

// ----------------------------------------------------------------------------
// Small helper functions
// ----------------------------------------------------------------------------

// Clean up text people type: make sure it's a string, trim spaces, cap length.
function clean(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, maxLength);
}

// A simple check that an email "looks like" an email (something@something.something).
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Send an error back to the page in a consistent shape: { error: "message" }.
function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// Routes that need to wait for something (like Cloudflare's bot check) are
// "async". This wrapper makes sure any unexpected error becomes a tidy reply.
const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Is "review before publishing" switched on? (Changed from the dashboard.)
const requireApproval = () => getSetting('require_approval') === '1';

// ----------------------------------------------------------------------------
// Database queries we reuse in several places
// ----------------------------------------------------------------------------

// This SQL builds the "idea card" data: the idea plus its category name,
// how many votes and (published) comments it has. (LEFT JOIN = "attach
// matching rows from another table, if any".)
const IDEA_SELECT = `
  SELECT i.id, i.title, i.description, i.status, i.category_id, i.created_at,
         i.author_name, i.approved, i.vote_adjustment,
         c.name AS category,
         (SELECT COUNT(*) FROM votes v    WHERE v.idea_id = i.id) AS real_votes,
         MAX(0, (SELECT COUNT(*) FROM votes v WHERE v.idea_id = i.id) + i.vote_adjustment) AS vote_count,
         (SELECT COUNT(*) FROM comments m WHERE m.idea_id = i.id AND m.approved = 1) AS comment_count
  FROM ideas i
  LEFT JOIN categories c ON c.id = i.category_id
`;

// Any idea (admin use).
function getIdea(id) {
  return db.prepare(`${IDEA_SELECT} WHERE i.id = ?`).get(id);
}
// Only ideas that are published on the board (public use).
function getPublicIdea(id) {
  return db.prepare(`${IDEA_SELECT} WHERE i.id = ? AND i.approved = 1`).get(id);
}

// Has this email address already voted on this idea? Returns true/false.
function hasVoted(ideaId, email) {
  if (!email) return false;
  return !!db.prepare('SELECT 1 FROM votes WHERE idea_id = ? AND email = ?').get(ideaId, email);
}

// Requests added by staff may have no email. Every vote row needs an email (so the
// "one vote per person" rule works), so a request without one gets a made-up,
// unique placeholder address. "invalid" is a reserved ending that can never be a
// real address. The placeholder is hidden everywhere staff or customers look.
const NO_EMAIL_SUFFIX = '@no-email.invalid';
const isPlaceholderEmail = (email) => String(email || '').endsWith(NO_EMAIL_SUFFIX);
const shownEmail = (email) => (isPlaceholderEmail(email) ? '' : email);

// ---- Staff-edited vote total and submitted date (for ideas moved over from another tool) ----
// Extra votes: a whole number from -10000 to 100000 (negative numbers lower the total;
// the shown total never goes below 0). Returns the number, or null if it isn't valid.
function parseVoteAdjustment(value) {
  if (value === '' || value === null || value === undefined) return null;
  // Only a real number, or text that is just digits (like "12"). Lists, objects and true/false are refused.
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN);
  return Number.isInteger(n) && n >= -10000 && n <= 100000 ? n : null;
}
// Submitted date: "YYYY-MM-DD", a real calendar day, from 2000 up to today. Returns the
// text for the database (noon, so time zones can't flip it to a neighbouring day), or null.
function parseSubmittedDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) return null; // e.g. 2026-02-31
  if (text < '2000-01-01' || day.getTime() > Date.now() + 14 * 3600 * 1000) return null;      // not in the future
  return `${text} 12:00:00`;
}

// Strip anything private before sending an idea to the public page.
function publicIdea(i) {
  return {
    id: i.id, title: i.title, description: i.description, status: i.status,
    category_id: i.category_id, category: i.category, created_at: i.created_at,
    author_name: i.author_name, vote_count: i.vote_count, comment_count: i.comment_count,
  };
}

// ---- Similar-idea lookups, with a cache ----
// Working out every idea's keywords on every keystroke gets slow as the board
// grows, so we work them out once and keep them in memory. Whenever ideas
// change, we throw the cached copy away and rebuild it on the next lookup.
let similarCache = null;
function invalidateSimilarCache() { similarCache = null; }
function similarCandidates() {
  if (!similarCache) {
    similarCache = db.prepare('SELECT id, title, description FROM ideas WHERE approved = 1')
      .all().map(prepareIdea);
  }
  return similarCache;
}

// Look for published ideas that resemble a title/description.
// Returns the matches plus the total number of people behind them.
function similarTo(title, description, excludeId = null, email = '') {
  const candidates = similarCandidates().filter((i) => i.id !== excludeId);
  const matches = findSimilar(title, description, candidates)
    .map((m) => getPublicIdea(m.id))
    .filter(Boolean)
    .map((i) => ({ ...publicIdea(i), has_voted: hasVoted(i.id, email) }));
  const people = matches.reduce((sum, i) => sum + i.vote_count, 0);
  return { matches, people };
}

// ============================================================================
// PUBLIC ROUTES — used by the customer-facing board (index.html)
// ============================================================================

// Statuses + categories for the filter menus, plus a fresh form token and the
// Turnstile site key (if switched on) for the bot checks.
app.get('/api/meta', (req, res) => {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
  res.json({
    statuses: STATUSES,
    categories,
    form_token: makeFormToken(),
    turnstile_site_key: turnstileSiteKey,
  });
});

// List published ideas, with optional filters: ?sort=top|new &status= &category= &q= &email=
app.get('/api/ideas', (req, res) => {
  const where = ['i.approved = 1'];
  const params = [];
  const status = clean(req.query.status, 30);
  const category = Number(req.query.category);
  const q = clean(req.query.q, 100);
  if (status)   { where.push('i.status = ?');      params.push(status); }
  if (category) { where.push('i.category_id = ?'); params.push(category); }
  if (q) {
    // Escape % and _ so they are searched for literally instead of acting as wildcards.
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  // "Top" = most votes first (this is your priority list). "New" = newest first.
  const order = req.query.sort === 'new'
    ? 'i.created_at DESC, i.id DESC'
    : 'vote_count DESC, i.created_at DESC, i.id DESC';

  // LIMIT caps the work per request, however big the board gets.
  const sql = `${IDEA_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`;
  const email = clean(req.query.email, 120).toLowerCase();
  res.json(db.prepare(sql).all(...params).map((i) => ({ ...publicIdea(i), has_voted: hasVoted(i.id, email) })));
});

// One published idea with its published comments (comment emails stay private).
app.get('/api/ideas/:id', (req, res) => {
  const idea = getPublicIdea(Number(req.params.id));
  if (!idea) return fail(res, 404, 'That idea no longer exists.');
  const comments = db.prepare(`SELECT id, name, body, is_admin, created_at FROM comments
                               WHERE idea_id = ? AND approved = 1 ORDER BY created_at, id`).all(idea.id);
  const email = clean(req.query.email, 120).toLowerCase();
  res.json({ ...publicIdea(idea), has_voted: hasVoted(idea.id, email), comments });
});

// Live "already suggested?" check while a customer is typing (has its own, stricter limit).
app.get('/api/similar', limits.similar, (req, res) => {
  const title = clean(req.query.title, 120);
  const description = clean(req.query.description, 2000);
  const email = clean(req.query.email, 120).toLowerCase();
  res.json(similarTo(title, description, null, email));
});

// Submit a NEW idea. The person who posts it automatically counts as its first vote.
app.post('/api/ideas', limits.write, limits.post, asyncRoute(async (req, res) => {
  const title = clean(req.body.title, 120);
  const description = clean(req.body.description, 2000);
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const categoryId = req.body.category_id ? Number(req.body.category_id) : null;

  if (categoryId !== null && !Number.isInteger(categoryId)) return fail(res, 400, 'Pick a category from the list.');
  if (title.length < 4) return fail(res, 400, 'Give your idea a title of at least 4 characters.');
  if (!name) return fail(res, 400, 'Enter your name.');
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email address, like name@company.com.');
  if (categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
    return fail(res, 400, 'Pick a category from the list.');
  }
  const botProblem = await checkHuman(req, { withTurnstile: true });
  if (botProblem) return fail(res, 400, botProblem);

  // Held for review if reviewing is on, or if it contains web links.
  const approved = requireApproval() || looksLikeSpam(title, description, name) ? 0 : 1;
  const ip = hashIp(req.ip);

  // A "transaction" groups steps so they all succeed together or not at all.
  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO ideas (title, description, category_id, author_name, author_email, approved, ip_hash)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(title, description, categoryId, name, email, approved, ip);
    db.prepare('INSERT INTO votes (idea_id, name, email, ip_hash) VALUES (?, ?, ?, ?)')
      .run(result.lastInsertRowid, name, email, ip);
    return Number(result.lastInsertRowid);
  });
  const id = create();
  if (approved) invalidateSimilarCache();

  // Tell the customer how many people already asked for something similar.
  const similar = similarTo(title, description, id, email);
  res.status(201).json({
    idea: { ...publicIdea(getIdea(id)), has_voted: true },
    pending: !approved,
    similar,
  });
}));

// Vote / un-vote (clicking the vote button again removes your vote).
app.post('/api/ideas/:id/vote', limits.write, limits.vote, asyncRoute(async (req, res) => {
  const idea = getPublicIdea(Number(req.params.id));
  if (!idea) return fail(res, 404, 'That idea no longer exists.');
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  if (!name) return fail(res, 400, 'Enter your name to vote.');
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email address to vote.');
  const botProblem = await checkHuman(req);
  if (botProblem) return fail(res, 400, botProblem);

  if (hasVoted(idea.id, email)) {
    db.prepare('DELETE FROM votes WHERE idea_id = ? AND email = ?').run(idea.id, email);
  } else {
    db.prepare('INSERT INTO votes (idea_id, name, email, ip_hash) VALUES (?, ?, ?, ?)')
      .run(idea.id, name, email, hashIp(req.ip));
  }
  res.json({ has_voted: hasVoted(idea.id, email), vote_count: getIdea(idea.id).vote_count });
}));

// Add a comment to a published idea.
app.post('/api/ideas/:id/comments', limits.write, limits.post, asyncRoute(async (req, res) => {
  const idea = getPublicIdea(Number(req.params.id));
  if (!idea) return fail(res, 404, 'That idea no longer exists.');
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const body = clean(req.body.body, 1000);
  if (!name) return fail(res, 400, 'Enter your name to comment.');
  if (!isEmail(email)) return fail(res, 400, 'Enter a valid email address to comment.');
  if (!body) return fail(res, 400, 'Write a comment first.');
  const botProblem = await checkHuman(req, { withTurnstile: true });
  if (botProblem) return fail(res, 400, botProblem);

  const approved = requireApproval() || looksLikeSpam(body, name) ? 0 : 1;
  db.prepare('INSERT INTO comments (idea_id, name, email, body, approved, ip_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(idea.id, name, email, body, approved, hashIp(req.ip));
  res.status(201).json({ ok: true, pending: !approved });
}));

// ============================================================================
// ADMIN LOGIN
// ----------------------------------------------------------------------------
// When you log in with the right password, the server creates a random
// "session token" and stores it in a cookie in your browser. Every admin
// request sends that cookie back, which proves it's you.
// (Sessions are kept in memory, so restarting the server logs you out.)
// ============================================================================

const sessions = new Map(); // token -> expiry time
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // stay logged in for 7 days
const COOKIE = 'fb_admin';

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// Compare passwords in "constant time" so attackers can't guess by timing.
function passwordMatches(attempt) {
  const a = crypto.createHash('sha256').update(String(attempt)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// "Middleware" = a check that runs before a route. This one blocks anyone
// who isn't logged in as admin.
function requireAdmin(req, res, next) {
  const token = readCookie(req, COOKIE);
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return fail(res, 401, 'Please log in.');
  }
  next();
}

app.post('/api/admin/login', limits.login, (req, res) => {
  if (!passwordMatches(clean(req.body.password, 200))) return fail(res, 401, 'That password is incorrect.');
  // Tidy up expired sessions so the list can't grow forever.
  for (const [t, expiry] of sessions) if (expiry < Date.now()) sessions.delete(t);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(readCookie(req, COOKIE));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// ============================================================================
// ADMIN ROUTES — used by the dashboard (admin.html). All require login.
// ============================================================================

// Numbers for the dashboard overview (published ideas only, plus a pending count).
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  const totals = {
    ideas: one('SELECT COUNT(*) AS n FROM ideas WHERE approved = 1'),
    // Total of every idea's vote count (real voters + any extra votes added by staff).
    votes: one(`SELECT COALESCE(SUM(x.vote_count), 0) AS n FROM (${IDEA_SELECT}) x WHERE x.approved = 1`),
    people: one(`SELECT COUNT(DISTINCT v.email) AS n FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.approved = 1 AND v.email NOT LIKE '%${NO_EMAIL_SUFFIX}'`),
    comments: one('SELECT COUNT(*) AS n FROM comments WHERE is_admin = 0 AND approved = 1'),
    pending: one('SELECT (SELECT COUNT(*) FROM ideas WHERE approved = 0) + (SELECT COUNT(*) FROM comments WHERE approved = 0) AS n'),
    ideas_this_week: one(`SELECT COUNT(*) AS n FROM ideas WHERE approved = 1 AND created_at >= datetime('now', '-7 days')`),
    votes_this_week: one(`SELECT COUNT(*) AS n FROM votes v JOIN ideas i ON i.id = v.idea_id WHERE i.approved = 1 AND v.created_at >= datetime('now', '-7 days')`),
  };
  const byStatus = STATUSES.map((s) => ({
    ...s,
    count: db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE status = ? AND approved = 1').get(s.key).n,
  }));
  const byCategory = db.prepare(`
    SELECT COALESCE(x.category, 'Uncategorized') AS name, COUNT(*) AS ideas, SUM(x.vote_count) AS votes
    FROM (${IDEA_SELECT}) x
    WHERE x.approved = 1
    GROUP BY x.category_id ORDER BY votes DESC
  `).all();
  res.json({ totals, byStatus, byCategory });
});

// Settings shown on the dashboard.
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const mail = digest.readConfig();
  res.json({
    require_approval: requireApproval(), turnstile_enabled: Boolean(turnstileSiteKey),
    digest_enabled: digest.missingSettings(mail).length === 0,
    digest_hour: mail.hour, digest_timezone: mail.timeZone, digest_to: mail.to.join(', '),
  });
});
app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  if (typeof req.body.require_approval === 'boolean') {
    setSetting('require_approval', req.body.require_approval ? '1' : '0');
  }
  res.json({ require_approval: requireApproval() });
});

// Everything waiting for review: new ideas and new comments.
app.get('/api/admin/pending', requireAdmin, (req, res) => {
  const ideas = db.prepare(`
    SELECT i.id, i.title, i.description, i.author_name, i.author_email, i.created_at, c.name AS category
    FROM ideas i LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.approved = 0 ORDER BY i.created_at`).all()
    .map((i) => ({ ...i, has_link: looksLikeSpam(i.title, i.description, i.author_name) }));
  const comments = db.prepare(`
    SELECT m.id, m.name, m.email, m.body, m.created_at, m.idea_id, i.title AS idea_title
    FROM comments m JOIN ideas i ON i.id = m.idea_id
    WHERE m.approved = 0 ORDER BY m.created_at`).all()
    .map((c) => ({ ...c, has_link: looksLikeSpam(c.body, c.name) }));
  res.json({ ideas, comments });
});

app.post('/api/admin/ideas/:id/approve', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE ideas SET approved = 1 WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return fail(res, 404, 'That idea no longer exists.');
  invalidateSimilarCache();
  res.json({ ok: true });
});

app.post('/api/admin/comments/:id/approve', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE comments SET approved = 1 WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return fail(res, 404, 'That comment no longer exists.');
  res.json({ ok: true });
});

// Every published idea, including the submitter's email (admins only).
app.get('/api/admin/ideas', requireAdmin, (req, res) => {
  const ideas = db.prepare(`
    SELECT x.*, i.author_email,
      (SELECT COUNT(*) FROM votes v WHERE v.idea_id = x.id
         AND v.created_at >= datetime('now', '-7 days')) AS votes_this_week,
      (SELECT MAX(created_at) FROM votes v WHERE v.idea_id = x.id) AS last_vote_at
    FROM (${IDEA_SELECT}) x JOIN ideas i ON i.id = x.id
    WHERE x.approved = 1
    ORDER BY x.vote_count DESC, x.created_at DESC, x.id DESC
  `).all();
  res.json(ideas);
});

// One idea with its full list of voters (names + emails) and comments.
// "same_network" counts how many OTHER voters on this idea came from the same
// network — a high number can mean one person voting under many emails.
app.get('/api/admin/ideas/:id', requireAdmin, (req, res) => {
  const idea = getIdea(Number(req.params.id));
  if (!idea) return fail(res, 404, 'That idea no longer exists.');
  const author_email = db.prepare('SELECT author_email FROM ideas WHERE id = ?').get(idea.id).author_email;
  const voters = db.prepare(`
    SELECT v.id, v.name, v.email, v.created_at,
      CASE WHEN v.ip_hash IS NULL THEN 0 ELSE
        (SELECT COUNT(*) FROM votes o WHERE o.idea_id = v.idea_id AND o.ip_hash = v.ip_hash AND o.id <> v.id)
      END AS same_network
    FROM votes v WHERE v.idea_id = ? ORDER BY v.created_at DESC`).all(idea.id);
  const comments = db.prepare('SELECT * FROM comments WHERE idea_id = ? ORDER BY created_at, id').all(idea.id);
  res.json({ ...idea, author_email, voters: voters.map((v) => ({ ...v, email: shownEmail(v.email) })), comments });
});

// Remove a single vote (e.g. one you believe is fake).
app.delete('/api/admin/votes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM votes WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Add a request on a customer's behalf (a phone call, a meeting, a support ticket...).
// Only the title is required. Name and email are optional. It is published at once,
// and counts as 1 request (a vote). The reply includes any similar ideas that already
// exist, so you can merge them if this is a duplicate.
app.post('/api/admin/ideas', requireAdmin, (req, res) => {
  const title = clean(req.body.title, 120);
  const description = clean(req.body.description, 2000);
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const status = req.body.status || 'under_review';
  const categoryId = req.body.category_id ? Number(req.body.category_id) : null;

  const hasExtra = req.body.vote_adjustment !== undefined && req.body.vote_adjustment !== null && req.body.vote_adjustment !== '';
  const extraVotes = hasExtra ? parseVoteAdjustment(req.body.vote_adjustment) : 0;
  const hasDate = String(req.body.created_date ?? '').trim() !== '';
  const createdAt = hasDate ? parseSubmittedDate(req.body.created_date) : null;

  if (title.length < 4) return fail(res, 400, 'Give the request a title of at least 4 characters.');
  if (extraVotes === null) return fail(res, 400, 'Extra votes must be a whole number.');
  if (hasDate && !createdAt) return fail(res, 400, 'The submitted date must be a real date in the past, like 2026-03-15.');
  if (email && !isEmail(email)) return fail(res, 400, 'That email address does not look right. You can also leave it blank.');
  if (!STATUSES.some((st) => st.key === status)) return fail(res, 400, 'Unknown status.');
  if (categoryId !== null && (!Number.isInteger(categoryId)
      || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId))) {
    return fail(res, 400, 'Pick a category from the list.');
  }

  const authorName = name || 'The team';
  // With no email, use a unique placeholder (see NO_EMAIL_SUFFIX above).
  const voteEmail = email || `${crypto.randomBytes(8).toString('hex')}${NO_EMAIL_SUFFIX}`;
  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO ideas (title, description, category_id, status, author_name, author_email, approved, vote_adjustment, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, 1, ?, COALESCE(?, datetime('now')))`)
      .run(title, description, categoryId, status, authorName, email, extraVotes, createdAt);
    // The requester's own vote also takes the submitted date, so "last vote" dates make sense.
    db.prepare("INSERT INTO votes (idea_id, name, email, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))")
      .run(result.lastInsertRowid, authorName, voteEmail, createdAt);
    return Number(result.lastInsertRowid);
  });
  const id = create();
  invalidateSimilarCache();
  const similar = similarTo(title, description, id);
  res.status(201).json({ idea: getIdea(id), similar });
});

// Edit an idea: title, description, status, category.
app.patch('/api/admin/ideas/:id', requireAdmin, (req, res) => {
  const idea = getIdea(Number(req.params.id));
  if (!idea) return fail(res, 404, 'That idea no longer exists.');
  const title = req.body.title !== undefined ? clean(req.body.title, 120) : idea.title;
  const description = req.body.description !== undefined ? clean(req.body.description, 2000) : idea.description;
  const status = req.body.status ?? idea.status;
  const categoryId = req.body.category_id !== undefined
    ? (req.body.category_id ? Number(req.body.category_id) : null)
    : idea.category_id;
  if (title.length < 4) return fail(res, 400, 'Titles need at least 4 characters.');

  // Extra votes and submitted date (only changed when the dashboard sends them).
  let voteAdjustment = idea.vote_adjustment;
  if (req.body.vote_adjustment !== undefined) {
    voteAdjustment = parseVoteAdjustment(req.body.vote_adjustment);
    if (voteAdjustment === null) return fail(res, 400, 'Extra votes must be a whole number.');
  }
  let createdAt = idea.created_at;
  if (req.body.created_date !== undefined && String(req.body.created_date).slice(0, 10) !== idea.created_at.slice(0, 10)) {
    createdAt = parseSubmittedDate(req.body.created_date);
    if (!createdAt) return fail(res, 400, 'The submitted date must be a real date in the past, like 2026-03-15.');
  }
  if (categoryId !== null && (!Number.isInteger(categoryId)
      || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId))) {
    return fail(res, 400, 'Pick a category from the list.');
  }
  if (!STATUSES.some((s) => s.key === status)) return fail(res, 400, 'Unknown status.');
  db.prepare('UPDATE ideas SET title = ?, description = ?, status = ?, category_id = ?, vote_adjustment = ?, created_at = ? WHERE id = ?')
    .run(title, description, status, categoryId, voteAdjustment, createdAt, idea.id);
  invalidateSimilarCache();
  res.json(getIdea(idea.id));
});

// Delete an idea (its votes and comments are deleted with it).
app.delete('/api/admin/ideas/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM ideas WHERE id = ?').run(Number(req.params.id));
  invalidateSimilarCache();
  res.json({ ok: true });
});

// MERGE a duplicate into another idea: its voters and comments move over,
// then the duplicate is removed. People who voted on both only count once.
app.post('/api/admin/ideas/:id/merge', requireAdmin, (req, res) => {
  const from = getIdea(Number(req.params.id));
  const into = getIdea(Number(req.body.into_id));
  if (!from || !into) return fail(res, 404, 'One of those ideas no longer exists.');
  if (from.id === into.id) return fail(res, 400, 'Pick a different idea to merge into.');
  if (!into.approved) return fail(res, 400, 'Approve that idea first: you can only merge into a published idea.');
  const merge = db.transaction(() => {
    // "INSERT OR IGNORE" skips voters who already voted on the target idea.
    db.prepare(`INSERT OR IGNORE INTO votes (idea_id, name, email, created_at, ip_hash)
                SELECT ?, name, email, created_at, ip_hash FROM votes WHERE idea_id = ?`).run(into.id, from.id);
    db.prepare('UPDATE comments SET idea_id = ? WHERE idea_id = ?').run(into.id, from.id);
    // Extra votes added by staff move across too.
    db.prepare('UPDATE ideas SET vote_adjustment = vote_adjustment + ? WHERE id = ?').run(from.vote_adjustment, into.id);
    db.prepare(`INSERT INTO comments (idea_id, name, body, is_admin) VALUES (?, 'Team', ?, 1)`)
      .run(into.id, `Merged in a similar suggestion: “${from.title}”`);
    db.prepare('DELETE FROM ideas WHERE id = ?').run(from.id);
  });
  merge();
  invalidateSimilarCache();
  res.json(getIdea(into.id));
});

// Post an official reply from your team on an idea (always published).
app.post('/api/admin/ideas/:id/comments', requireAdmin, (req, res) => {
  const body = clean(req.body.body, 1000);
  if (!body) return fail(res, 400, 'Write a reply first.');
  if (!getIdea(Number(req.params.id))) return fail(res, 404, 'That idea no longer exists.');
  db.prepare(`INSERT INTO comments (idea_id, name, body, is_admin) VALUES (?, 'Team', ?, 1)`)
    .run(Number(req.params.id), body);
  res.status(201).json({ ok: true });
});

app.delete('/api/admin/comments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Send a test copy of the daily summary right now (looks back 7 days).
app.post('/api/admin/digest/test', requireAdmin, asyncRoute(async (req, res) => {
  const config = digest.readConfig();
  const missing = digest.missingSettings(config);
  if (missing.length) return fail(res, 400, `The summary email is not set up yet. Missing: ${missing.join(', ')}.`);
  try {
    const result = await digest.sendDigest({ config, force: true });
    if (!result.sent) return res.json({ sent: false, message: 'Nothing new in the last 7 days, so no email was sent.' });
    res.json({ sent: true, message: `Test summary sent to ${config.to.join(', ')}.` });
  } catch (err) {
    console.error('Test summary failed:', err.message);
    // Show the reason (it never contains passwords or keys) so you can fix the problem.
    fail(res, 502, `The email could not be sent: ${String(err.message).slice(0, 200)}`);
  }
}));

// Manage categories.
app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return fail(res, 400, 'Enter a category name.');
  try {
    const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json({ id: Number(r.lastInsertRowid), name });
  } catch {
    fail(res, 400, 'That category already exists.');
  }
});

app.patch('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return fail(res, 400, 'Enter a category name.');
  try {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    res.json({ ok: true });
  } catch {
    fail(res, 400, 'That category already exists.');
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  // Ideas in this category become "Uncategorized" (handled by ON DELETE SET NULL).
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// CSV downloads (open in Excel / Google Sheets)
// ----------------------------------------------------------------------------
function toCsv(rows, columns) {
  const escape = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // stop spreadsheet formula tricks
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n');
}

app.get('/api/admin/export/ideas.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT x.*, i.author_email, CASE WHEN x.approved = 1 THEN 'published' ELSE 'waiting for review' END AS visibility
    FROM (${IDEA_SELECT}) x JOIN ideas i ON i.id = x.id
    ORDER BY x.vote_count DESC`).all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="feature-suggestions.csv"');
  res.send(toCsv(rows, ['id', 'title', 'description', 'category', 'status', 'vote_count',
    'comment_count', 'author_name', 'author_email', 'visibility', 'created_at']));
});

app.get('/api/admin/ideas/:id/voters.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT name, email, created_at FROM votes WHERE idea_id = ? ORDER BY created_at')
    .all(Number(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="idea-${Number(req.params.id)}-voters.csv"`);
  res.send(toCsv(rows.map((r) => ({ ...r, email: shownEmail(r.email) })), ['name', 'email', 'created_at']));
});

// ----------------------------------------------------------------------------
// Error handling
// ----------------------------------------------------------------------------
// Unknown API address → a plain "not found" message.
app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// Anything that goes wrong (broken JSON sent by an attacker, oversized
// requests, unexpected bugs) gets a short, safe message — never the internal
// error details, which could help an attacker.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'That\'s too much text to send at once.');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'The request was not valid.');
  if (err.status >= 400 && err.status < 500) return fail(res, err.status, 'The request was not valid.');
  console.error(err);
  fail(res, 500, 'Something went wrong on our side. Please try again.');
});

// ----------------------------------------------------------------------------
// Start listening for visitors.
// ----------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  const port = server.address().port; // the real port (differs from PORT when PORT=0 asks for any free one)
  console.log(`Feature board running → http://localhost:${port}`);
  console.log(`Admin dashboard       → http://localhost:${port}/admin.html`);
  if (!turnstileSiteKey) console.log('Cloudflare Turnstile bot check: off (see README to switch it on)');
  digest.startDigestTimer();   // the daily summary email (digest.js)
});

// Drop connections that dribble data in extremely slowly (a classic way to tie
// up a server, known as a "slowloris" attack).
server.headersTimeout = 20 * 1000;
server.requestTimeout = 30 * 1000;
