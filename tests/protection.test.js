// ============================================================================
// tests/protection.test.js — abuse protection, safe errors and exposed files
// ============================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s;
before(async () => { s = await startServer(); await s.setApproval(false); });
after(async () => { await s.stop(); s.cleanup(); });
const ip = (n) => ({ ip: `10.50.${n}.1` });

describe('bot checks on the API', () => {
  test('a post without a token is refused', async () => {
    const res = await s.postIdea({ form_token: undefined }, ip(1));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /refresh/i);
  });

  test('a post made instantly after the page loaded is refused as too fast', async () => {
    const fresh = (await s.get('/api/meta')).json.form_token;
    const res = await s.postIdea({ form_token: fresh }, ip(2));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /quick/i);
  });

  test('filling the hidden "website" field is refused, and nothing is saved', async () => {
    const before = (await s.get('/api/ideas')).json.length;
    const res = await s.postIdea({ website: 'http://bot.example' }, ip(3));
    assert.equal(res.status, 400);
    assert.equal((await s.get('/api/ideas')).json.length, before);
  });

  test('votes and comments need the token too', async () => {
    const idea = await s.makeIdea({ title: 'Token protected idea' }, ip(4));
    const v = await s.post(`/api/ideas/${idea.id}/vote`, { name: 'A', email: 'a@example.com' }, ip(5));
    const c = await s.post(`/api/ideas/${idea.id}/comments`, { name: 'A', email: 'a@example.com', body: 'hi' }, ip(5));
    assert.equal(v.status, 400);
    assert.equal(c.status, 400);
  });
});

describe('hostile input is handled safely', () => {
  test('broken JSON gives a clean 400 without internal details', async () => {
    const res = await s.req('POST', '/api/ideas', { raw: '{"title": ', ...ip(10) });
    assert.equal(res.status, 400);
    assert.ok(!/SyntaxError|at .*\.js|node_modules/.test(res.text));
  });

  test('a request bigger than 20 KB is refused with 413', async () => {
    const res = await s.postIdea({ description: 'x'.repeat(30000) }, ip(11));
    assert.equal(res.status, 413);
  });

  test('wrong content type / empty body / JSON that is not an object do not crash the server', async () => {
    for (const raw of ['', 'null', '[]', '"text"', '12']) {
      const res = await s.req('POST', '/api/ideas', { raw, ...ip(12) });
      assert.ok([400, 413].includes(res.status), `${raw} -> ${res.status}`);
    }
    const form = await s.req('POST', '/api/ideas', { raw: 'title=abc', headers: { 'Content-Type': 'text/plain' }, ...ip(12) });
    assert.equal(form.status, 400);
    assert.equal((await s.get('/api/meta')).status, 200, 'server still alive');
  });

  test('SQL-injection style text is stored as plain text and harms nothing', async () => {
    const evil = `Robert'); DROP TABLE ideas;-- title`;
    const idea = await s.makeIdea({ title: evil, name: `' OR 1=1 --` }, ip(13));
    assert.equal(idea.title, evil);
    assert.equal((await s.get('/api/ideas')).status, 200);
    assert.equal((await s.get('/api/ideas?q=' + encodeURIComponent("' OR '1'='1"))).json.length, 0);
    assert.equal((await s.get('/api/ideas?category=1%20OR%201=1')).status, 200);
  });

  test('script tags are kept as harmless text by the API (the pages show them as text)', async () => {
    const idea = await s.makeIdea({ title: '<script>alert(1)</script> title' }, ip(14));
    assert.equal(idea.title, '<script>alert(1)</script> title');
  });

  test('unknown API addresses give a JSON 404', async () => {
    const res = await s.get('/api/nothing-here');
    assert.equal(res.status, 404);
    assert.ok(res.json.error);
  });

  test('a non-numeric idea id is a 404, not a crash', async () => {
    assert.equal((await s.get('/api/ideas/abc')).status, 404);
    assert.equal((await s.vote('abc', 'a@example.com', 'A', ip(15))).status, 404);
  });
});

describe('files that must never be downloadable', () => {
  for (const p of ['/data.db', '/data.db-wal', '/server.js', '/db.js', '/security.js', '/package.json',
    '/README.md', '/node_modules/express/package.json', '/tests/helpers.js', '/.env', '/../server.js', '/%2e%2e/server.js']) {
    test(`GET ${p} is not served`, async () => {
      const res = await s.get(p);
      assert.ok(res.status === 404 || res.status === 400, `${p} -> ${res.status}`);
      assert.ok(!/require\(|SQLite format/.test(res.text));
    });
  }

  test('the public pages are served', async () => {
    for (const p of ['/', '/index.html', '/app.js', '/styles.css', '/admin.html']) {
      assert.equal((await s.get(p)).status, 200, p);
    }
  });
});

describe('security headers over real HTTP', () => {
  test('public page', async () => {
    const h = (await s.get('/')).headers;
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.match(h.get('content-security-policy'), /script-src 'self'/);
    assert.equal(h.get('x-powered-by'), null);
  });
  test('admin page cannot be framed', async () => {
    const h = (await s.get('/admin.html')).headers;
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

describe('rate limits (a flood is slowed down, normal use is not)', () => {
  test('posting: 30 new ideas per hour per address, then a polite 429 with Retry-After', async () => {
    const who = ip(30);
    let blockedAt = 0, last;
    for (let i = 1; i <= 33; i++) {
      last = await s.postIdea({ title: `Flood idea number ${i} abc${i}`, email: `f${i}@example.com` }, who);
      if (last.status === 429 && !blockedAt) blockedAt = i;
    }
    assert.equal(blockedAt, 31);
    assert.match(last.json.error, /too many|slow down|try again/i);
    assert.ok(last.headers.get('retry-after'));
  });

  test('another visitor is not affected by someone else being blocked', async () => {
    assert.equal((await s.postIdea({ title: 'Different visitor idea' }, ip(31))).status, 201);
  });

  test('the limit survives a server restart (it is stored in the database)', async () => {
    await s.restart();
    assert.equal((await s.postIdea({ title: 'After restart idea abc' }, ip(30))).status, 429);
    assert.equal((await s.postIdea({ title: 'After restart other' }, ip(32))).status, 201);
  });

  test('voting: 100 per hour per address', async () => {
    const idea = await s.makeIdea({ title: 'Vote flood target idea' }, ip(40));
    let blockedAt = 0;
    for (let i = 1; i <= 103; i++) {
      const res = await s.vote(idea.id, `vf${i}@example.com`, 'V', ip(41));
      if (res.status === 429 && !blockedAt) blockedAt = i;
    }
    assert.equal(blockedAt, 101);
  });

  test('live "similar" checks have their own limit (60 per minute)', async () => {
    let blockedAt = 0;
    for (let i = 1; i <= 63; i++) {
      const res = await s.get('/api/similar?title=dark+mode', ip(50));
      if (res.status === 429 && !blockedAt) blockedAt = i;
    }
    assert.equal(blockedAt, 61);
  });

  test('a spoofed X-Forwarded-For with extra addresses cannot dodge the limit', async () => {
    // Only the address added by the trusted proxy (the last one) counts.
    let blockedAt = 0;
    for (let i = 1; i <= 63; i++) {
      const res = await s.req('GET', '/api/similar?title=dark+mode', { ip: `1.1.1.${i}, 10.50.60.1` });
      if (res.status === 429 && !blockedAt) blockedAt = i;
    }
    assert.equal(blockedAt, 61);
  });
});

describe('browser tab icon (favicon)', () => {
  test('both pages link to the icons, and the icon files are served with the right type', async () => {
    for (const page of ['/', '/admin.html']) {
      const html = (await s.get(page)).text;
      assert.match(html, /rel="icon" href="\/favicon\.svg"/, page);
      assert.match(html, /rel="icon" href="\/favicon\.png"/, page);
      assert.match(html, /rel="icon" href="\/favicon\.ico"/, page);
      assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/, page);
    }
    const checks = [['/favicon.svg', /image\/svg\+xml/], ['/favicon.png', /image\/png/], ['/favicon.ico', /icon/], ['/apple-touch-icon.png', /image\/png/]];
    for (const [file, type] of checks) {
      const res = await s.get(file);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), type, file);
    }
  });
});
