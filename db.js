// ============================================================================
// db.js — the DATABASE
// ----------------------------------------------------------------------------
// This file creates (or opens) a small database file called "data.db" and
// sets up the "tables" inside it. Think of each table as a spreadsheet tab:
//
//   categories  → the product areas you tag ideas with (e.g. "Reporting")
//   ideas       → each feature suggestion a customer posts
//   votes       → one row per customer per idea ("I want this too!")
//   comments    → discussion on an idea (customers and you, the admin)
//
// We use SQLite: the whole database lives in ONE file on disk, so there is
// no separate database server to install. Great for small/medium apps.
// ============================================================================

const Database = require('better-sqlite3');
const path = require('path');
const { loadBrand } = require('./brand');

// Where the database file lives. You can override it with the DB_PATH
// environment variable (useful on hosting services with a "persistent disk").
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbFile);

// WAL mode makes SQLite handle many readers + a writer smoothly.
db.pragma('journal_mode = WAL');
// Make SQLite enforce the links between tables (e.g. a vote must belong to a real idea).
db.pragma('foreign_keys = ON');

// "CREATE TABLE IF NOT EXISTS" means: build the table the first time the app
// runs, and leave it alone (keeping your data) every time after that.
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,   -- a unique number for each row
    name  TEXT NOT NULL UNIQUE                 -- e.g. "Integrations"
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'under_review',
    author_name   TEXT NOT NULL,
    author_email  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (idea_id, email)          -- one vote per email address per idea
  );

  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,   -- 1 = written by you (shown as "Team")
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indexes are like a book's index: they make lookups by idea faster.
  CREATE INDEX IF NOT EXISTS idx_votes_idea    ON votes(idea_id);
  CREATE INDEX IF NOT EXISTS idx_comments_idea ON comments(idea_id);

  -- App settings you can change from the dashboard (e.g. "review before publishing").
  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  -- Spam-limit counters: "this visitor did N actions in this time window".
  -- Kept in the database (not memory) so they survive restarts.
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket        TEXT NOT NULL,      -- which limit, e.g. "write" or "login"
    key           TEXT NOT NULL,      -- a scrambled version of the visitor's IP address
    window_start  INTEGER NOT NULL,   -- when this time window began (milliseconds)
    count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, key, window_start)
  );
`);

// ----------------------------------------------------------------------------
// Upgrading older databases
// ----------------------------------------------------------------------------
// If you already ran an earlier version of the app, your data.db is missing
// a few newer columns. This adds them (only if missing) without touching data.
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// approved: 1 = visible on the public board, 0 = waiting for your review.
addColumnIfMissing('ideas', 'approved', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('comments', 'approved', 'INTEGER NOT NULL DEFAULT 1');
// ip_hash: a scrambled fingerprint of the network a post or vote came from.
// It can't be turned back into an IP address, but lets you spot many votes
// coming from the same place (a sign of vote-stuffing).
addColumnIfMissing('ideas', 'ip_hash', 'TEXT');
// Extra votes added by staff (for example votes collected offline or moved over from another tool).
// Real voters stay in the votes table; this number is added on top when counting.
addColumnIfMissing('ideas', 'vote_adjustment', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('votes', 'ip_hash', 'TEXT');
addColumnIfMissing('comments', 'ip_hash', 'TEXT');

// ----------------------------------------------------------------------------
// Settings helpers
// ----------------------------------------------------------------------------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// First-run defaults. "INSERT OR IGNORE" never overwrites a value you changed.
const crypto = require('crypto');
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('require_approval', '1')`).run();
// A random secret used to scramble IP addresses and sign form tokens.
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('secret', ?)`)
  .run(crypto.randomBytes(32).toString('hex'));

// The list of statuses an idea can have. The "key" is what's stored in the
// database; the "label" is what people see on screen.
const STATUSES = [
  { key: 'under_review', label: 'Under review' },
  { key: 'planned',      label: 'Planned' },
  { key: 'in_progress',  label: 'In progress' },
  { key: 'done',         label: 'Done' },
  { key: 'not_planned',  label: 'Not planned' },
];

// First run only: add a few starter categories so the board isn't empty.
// You can rename or delete these from the admin dashboard.
const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
if (categoryCount === 0) {
  const add = db.prepare('INSERT INTO categories (name) VALUES (?)');
  // The starter list comes from branding/brand.json ("categories").
  loadBrand().categories.forEach((name) => add.run(name));
}

module.exports = { db, STATUSES, getSetting, setSetting };
