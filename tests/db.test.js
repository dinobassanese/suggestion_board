// ============================================================================
// tests/db.test.js — the database setup in db.js
// ----------------------------------------------------------------------------
// Checks that a new database is created correctly, and that a database made by
// an EARLIER version of the app is upgraded without losing any data.
// Each check runs db.js in a separate small program (like a real server start).
// ============================================================================

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ROOT } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-board-db-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Run db.js against a database file, then print something about it.
function runDb(dbPath, code = '') {
  return execFileSync(process.execPath, ['-e', `const m = require('./db'); ${code}`], {
    cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, BRAND_DIR: path.join(__dirname, 'fixtures', 'brand') }, encoding: 'utf8',
  }).trim();
}
const inspect = (dbPath, sql) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

describe('a brand-new database', () => {
  const dbPath = path.join(tmp, 'new.db');
  runDb(dbPath);

  test('has every table the app needs', () => {
    const tables = inspect(dbPath, `SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    for (const name of ['categories', 'ideas', 'votes', 'comments', 'settings', 'rate_limits']) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
  });

  test('starts with the starter categories from brand.json', () => {
    const names = inspect(dbPath, 'SELECT name FROM categories ORDER BY id').map((c) => c.name);
    assert.deepEqual(names, [
      'Scheduling', 'Online Booking', 'Billing & Payments', 'Forms',
      'Charting & Session Notes', 'Reminders & Notifications', 'Other',
    ]);
  });

  test('reviewing new posts before publishing is on by default', () => {
    const [row] = inspect(dbPath, `SELECT value FROM settings WHERE key = 'require_approval'`);
    assert.equal(row.value, '1');
  });

  test('creates a long random private secret', () => {
    const [row] = inspect(dbPath, `SELECT value FROM settings WHERE key = 'secret'`);
    assert.match(row.value, /^[0-9a-f]{64}$/);
  });

  test('opening it again changes nothing: same secret, no duplicate categories, setting kept', () => {
    const before = inspect(dbPath, 'SELECT key, value FROM settings ORDER BY key');
    runDb(dbPath, `m.setSetting('require_approval', '0');`);
    runDb(dbPath);
    const afterRows = inspect(dbPath, 'SELECT key, value FROM settings ORDER BY key');
    assert.equal(afterRows.find((r) => r.key === 'secret').value, before.find((r) => r.key === 'secret').value);
    assert.equal(afterRows.find((r) => r.key === 'require_approval').value, '0', 'a changed setting must not be reset');
    assert.equal(inspect(dbPath, 'SELECT COUNT(*) AS n FROM categories')[0].n, 7);
  });

  test('getSetting / setSetting round-trip, and unknown settings are null', () => {
    const out = runDb(dbPath, `m.setSetting('x', 5); console.log(JSON.stringify([m.getSetting('x'), m.getSetting('nope')]))`);
    assert.deepEqual(JSON.parse(out), ['5', null]);
  });

  test('the database enforces its own rules: one vote per email per idea, and valid links between tables', () => {
    const out = runDb(dbPath, `
      const { db } = m; const result = [];
      const id = db.prepare("INSERT INTO ideas (title, author_name, author_email) VALUES ('t','n','e@x.com')").run().lastInsertRowid;
      db.prepare("INSERT INTO votes (idea_id, name, email) VALUES (?, 'n', 'e@x.com')").run(id);
      try { db.prepare("INSERT INTO votes (idea_id, name, email) VALUES (?, 'n', 'e@x.com')").run(id); result.push('dup-vote-allowed'); } catch { result.push('dup-vote-blocked'); }
      try { db.prepare("INSERT INTO votes (idea_id, name, email) VALUES (99999, 'n', 'q@x.com')").run(); result.push('orphan-allowed'); } catch { result.push('orphan-blocked'); }
      db.prepare("DELETE FROM ideas WHERE id = ?").run(id);
      result.push('votes-left-after-delete:' + db.prepare('SELECT COUNT(*) n FROM votes').get().n);
      console.log(JSON.stringify(result));`);
    assert.deepEqual(JSON.parse(out), ['dup-vote-blocked', 'orphan-blocked', 'votes-left-after-delete:0']);
  });
});

describe('upgrading a database made by an earlier version of the app', () => {
  const dbPath = path.join(tmp, 'old.db');
  // The original schema, before approval, scrambled IPs, settings and spam limits existed.
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'under_review',
      author_name TEXT NOT NULL, author_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (idea_id, email));
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO categories (name) VALUES ('My Own Category');
    INSERT INTO ideas (title, description, category_id, author_name, author_email) VALUES ('Old idea', 'kept', 1, 'Ann', 'ann@x.com');
    INSERT INTO votes (idea_id, name, email) VALUES (1, 'Ann', 'ann@x.com'), (1, 'Bob', 'bob@x.com');
    INSERT INTO comments (idea_id, name, email, body) VALUES (1, 'Bob', 'bob@x.com', 'old comment');
  `);
  old.close();
  runDb(dbPath);

  test('keeps all existing ideas, votes and comments', () => {
    assert.equal(inspect(dbPath, 'SELECT title, description FROM ideas')[0].title, 'Old idea');
    assert.equal(inspect(dbPath, 'SELECT COUNT(*) AS n FROM votes')[0].n, 2);
    assert.equal(inspect(dbPath, 'SELECT body FROM comments')[0].body, 'old comment');
  });

  test('adds the new columns', () => {
    const cols = (t) => inspect(dbPath, `PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(cols('ideas').includes('approved') && cols('ideas').includes('ip_hash'));
    assert.ok(cols('ideas').includes('vote_adjustment'));
    assert.ok(cols('votes').includes('ip_hash'));
    assert.ok(cols('comments').includes('approved') && cols('comments').includes('ip_hash'));
  });

  test('existing ideas and comments stay PUBLIC (not suddenly hidden for review)', () => {
    assert.equal(inspect(dbPath, 'SELECT approved FROM ideas')[0].approved, 1);
    assert.equal(inspect(dbPath, 'SELECT approved FROM comments')[0].approved, 1);
  });

  test('existing ideas start with no extra votes', () => {
    assert.equal(inspect(dbPath, 'SELECT vote_adjustment FROM ideas')[0].vote_adjustment, 0);
  });

  test('does not add starter categories to a board that already has its own', () => {
    assert.deepEqual(inspect(dbPath, 'SELECT name FROM categories').map((c) => c.name), ['My Own Category']);
  });

  test('upgrading twice is harmless', () => {
    runDb(dbPath);
    assert.equal(inspect(dbPath, 'SELECT COUNT(*) AS n FROM ideas')[0].n, 1);
  });
});
