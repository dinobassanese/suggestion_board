// ============================================================================
// tests/helpers.js — shared tools used by the test files
// ----------------------------------------------------------------------------
// Each test file that needs the web server calls startServer(). That:
//   • creates a brand-new, empty database in a temporary folder
//   • starts the real server (server.js) on any free port
//   • gives you small helpers to send requests, log in as admin, and so on
// Because every file gets its own server and database, tests can't interfere
// with each other, and your real data.db is never touched.
//
// Visitors are identified by IP address (for spam limits). All test requests
// come from this computer, so the helper sends a pretend address in the
// "X-Forwarded-For" header. Pass { ip: '10.9.9.9' } to act as someone else.
// ============================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADMIN_PASSWORD = 'test-password';

class TestServer {
  constructor(options = {}) {
    this.env = options.env || {};
    this.dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'feature-board-test-'));
    this.dbPath = path.join(this.dir, 'data.db');
    this.defaultIp = '10.0.0.1';
    this.child = null;
    this.base = '';
    this.token = '';
    this._admin = null;
  }

  // Start server.js and wait until it says which port it is using.
  async start() {
    this.child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        DB_PATH: this.dbPath,
        BRAND_DIR: path.join(__dirname, 'fixtures', 'brand'),   // a fixed test brand, whatever your real branding folder holds
        ADMIN_PASSWORD,
        TRUST_PROXY: '',            // use the default (1)
        EMBED_ALLOWED_SITES: '',
        TURNSTILE_SITE_KEY: '',
        TURNSTILE_SECRET_KEY: '',
        RESEND_API_KEY: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', DIGEST_TO: '',
        ...this.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.output = '';
    this.base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start:\n' + this.output)), 15000);
      const onData = (chunk) => {
        this.output += chunk.toString();
        const match = this.output.match(/running → (http:\/\/localhost:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      this.child.stdout.on('data', onData);
      this.child.stderr.on('data', (c) => { this.output += c.toString(); });
      this.child.on('exit', (code) => reject(new Error(`Server exited early (${code}):\n${this.output}`)));
    });
    // The server rejects posts made less than 2 seconds after a page loads (a
    // bot check). Get a token now and let it "age" so tests can use it freely.
    const meta = await this.get('/api/meta');
    this.token = meta.json.form_token;
    await new Promise((r) => setTimeout(r, 2200));
    return this;
  }

  async stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.removeAllListeners('exit');
      this.child.kill();
      await new Promise((r) => this.child.once('exit', r));
    }
  }

  // Stop and start again on the SAME database (to prove data/limits survive a restart).
  async restart() {
    await this.stop();
    this._admin = null;
    return this.start();
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // Send a request. Returns { status, headers, text, json }.
  async req(method, url, { body, raw, headers = {}, cookie, ip } = {}) {
    const h = { 'X-Forwarded-For': ip || this.defaultIp, ...headers };
    let payload;
    if (raw !== undefined) { payload = raw; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    if (cookie) h.Cookie = cookie;
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  get(url, opts) { return this.req('GET', url, opts); }
  post(url, body, opts) { return this.req('POST', url, { ...opts, body }); }

  // ---- Public-side shortcuts ----

  // Post an idea. Every field can be overridden; the bot-check token is added for you.
  postIdea(overrides = {}, opts = {}) {
    const body = {
      title: 'Add a client portal',
      name: 'Test Person',
      email: 'person@example.com',
      form_token: this.token,
      ...overrides,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return this.post('/api/ideas', body, opts);
  }
  // Post an idea and insist it succeeds; returns the idea object.
  async makeIdea(overrides = {}, opts = {}) {
    const res = await this.postIdea(overrides, opts);
    if (res.status !== 201) throw new Error(`makeIdea failed (${res.status}): ${res.text}`);
    return res.json.idea;
  }
  vote(ideaId, email, name = 'Voter', opts = {}) {
    return this.post(`/api/ideas/${ideaId}/vote`, { name, email, form_token: this.token }, opts);
  }
  comment(ideaId, body, overrides = {}, opts = {}) {
    return this.post(`/api/ideas/${ideaId}/comments`, {
      name: 'Commenter', email: 'commenter@example.com', body, form_token: this.token, ...overrides,
    }, opts);
  }
  // Add `n` extra votes from distinct made-up customers.
  async addVotes(ideaId, n, prefix = 'v') {
    for (let i = 0; i < n; i++) {
      const res = await this.vote(ideaId, `${prefix}${i}-${ideaId}@example.com`, `Voter ${i}`, { ip: `10.8.${ideaId % 200}.${i % 200 + 1}` });
      if (res.status !== 200) throw new Error(`addVotes failed: ${res.text}`);
    }
  }

  // ---- Admin-side shortcuts ----

  // Log in once (cached) and return an object with get/post/patch/del that send the admin cookie.
  async admin() {
    if (this._admin) return this._admin;
    const res = await this.post('/api/admin/login', { password: ADMIN_PASSWORD }, { ip: '10.250.0.1' });
    if (res.status !== 200) throw new Error('Admin login failed: ' + res.text);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const send = (method, url, body, opts = {}) =>
      this.req(method, url, { ...opts, body, cookie, ip: opts.ip || '10.250.0.1' });
    this._admin = {
      cookie,
      get: (url, opts) => send('GET', url, undefined, opts),
      post: (url, body, opts) => send('POST', url, body ?? {}, opts),
      patch: (url, body, opts) => send('PATCH', url, body, opts),
      del: (url, opts) => send('DELETE', url, undefined, opts),
    };
    return this._admin;
  }
  async setApproval(on) {
    const a = await this.admin();
    const res = await a.patch('/api/admin/settings', { require_approval: on });
    if (res.status !== 200) throw new Error('setApproval failed');
  }
  async approveAll() {
    const a = await this.admin();
    const pending = (await a.get('/api/admin/pending')).json;
    for (const i of pending.ideas) await a.post(`/api/admin/ideas/${i.id}/approve`);
    for (const c of pending.comments) await a.post(`/api/admin/comments/${c.id}/approve`);
  }

  // Open the database file read-only, to check what was really stored.
  openDb() {
    const Database = require('better-sqlite3');
    return new Database(this.dbPath, { readonly: true });
  }
}

async function startServer(options) {
  const server = new TestServer(options);
  await server.start();
  return server;
}

module.exports = { startServer, TestServer, ROOT, ADMIN_PASSWORD };
