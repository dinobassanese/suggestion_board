// ============================================================================
// tests/security.test.js — the protection helpers in security.js
// ----------------------------------------------------------------------------
// Tests the bot checks (form token, hidden trap field), link detection, IP
// scrambling and browser security headers, directly, without a web server.
// ============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// security.js opens the database when loaded, so point it at a throwaway one FIRST.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-board-sec-'));
process.env.DB_PATH = path.join(dir, 'data.db');

const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const security = require('../security');
const { db } = require('../db');

after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Make "now" jump forward so we can test timing without waiting.
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });
const skipAhead = (ms) => { const start = realNow(); Date.now = () => start + ms; };

const humanCheck = (body) => security.checkHuman({ body, ip: '1.2.3.4' });
const tokenAfter = async (ms) => {
  const token = security.makeFormToken();
  skipAhead(ms);
  return token;
};

describe('form token (bot check)', () => {
  test('looks like "<timestamp>.<32 hex characters>"', () => {
    assert.match(security.makeFormToken(), /^\d{13}\.[0-9a-f]{32}$/);
  });

  test('is accepted once it is old enough', async () => {
    const token = await tokenAfter(2500);
    assert.equal(await humanCheck({ form_token: token }), null);
  });

  test('is rejected when used less than 2 seconds after it was issued (too fast for a person)', async () => {
    const token = security.makeFormToken();
    assert.match(await humanCheck({ form_token: token }), /very quick/i);
  });

  test('is rejected after a week (page left open too long)', async () => {
    const token = await tokenAfter(8 * 24 * 60 * 60 * 1000);
    assert.match(await humanCheck({ form_token: token }), /open a long time/i);
  });

  test('is still accepted just inside the one-week limit', async () => {
    const token = await tokenAfter(6 * 24 * 60 * 60 * 1000);
    assert.equal(await humanCheck({ form_token: token }), null);
  });

  test('a changed timestamp is rejected (cannot be forged)', async () => {
    const [issued, signature] = security.makeFormToken().split('.');
    const forged = `${Number(issued) - 10_000}.${signature}`;
    skipAhead(5000);
    assert.match(await humanCheck({ form_token: forged }), /refresh/i);
  });

  test('a made-up signature is rejected', async () => {
    skipAhead(5000);
    const fake = `${realNow() - 10_000}.${'a'.repeat(32)}`;
    assert.match(await humanCheck({ form_token: fake }), /refresh/i);
  });

  for (const [label, value] of [
    ['missing', undefined],
    ['empty', ''],
    ['no dot', 'abc'],
    ['a number', 12345],
    ['an object', { a: 1 }],
    ['a list', ['1.2']],
    ['null', null],
    ['signature too short', '1700000000000.abc'],
    ['signature with accented letters (32 characters but more than 32 bytes)', '1700000000000.' + 'é'.repeat(32)],
    ['signature with emoji', '1700000000000.' + '😀'.repeat(16)],
    ['non-numeric timestamp', 'abc.' + 'a'.repeat(32)],
  ]) {
    test(`rejects a token that is ${label} (and does not crash)`, async () => {
      const result = await humanCheck({ form_token: value });
      assert.equal(typeof result, 'string');
      assert.match(result, /refresh/i);
    });
  }
});

describe('hidden trap field (honeypot)', () => {
  test('a request that fills in the trap field is rejected, even with a valid token', async () => {
    const token = await tokenAfter(3000);
    assert.match(await humanCheck({ form_token: token, website: 'http://bot.example' }), /couldn.t accept/i);
  });

  test('an empty trap field is fine', async () => {
    const token = await tokenAfter(3000);
    assert.equal(await humanCheck({ form_token: token, website: '' }), null);
  });
});

describe('Cloudflare Turnstile', () => {
  test('is off unless both keys are configured, so no site key is exposed', () => {
    assert.equal(security.turnstileSiteKey, '');
  });
});

describe('Turnstile keys with stray spaces', () => {
  test('spaces and line breaks around the keys are ignored', () => {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./security').turnstileSiteKey))"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: path.join(dir, 'trim.db'), TURNSTILE_SITE_KEY: ' 0xABC123 \n', TURNSTILE_SECRET_KEY: '\tsecret ' },
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(out.trim()), '0xABC123');
  });
});

describe('looksLikeSpam() — web links in posts', () => {
  for (const text of [
    'Visit https://spam.example now',
    'http://x.co',
    'check www.cheap-watches.net',
    'Buy now at spam-site.xyz',
    'cheap pills pharmacy.shop',
    'HTTPS://SHOUTING.EXAMPLE',
    'contact me at promo.ru',
  ]) {
    test(`flags: ${text}`, () => assert.equal(security.looksLikeSpam(text), true));
  }

  for (const text of [
    'Let clients join a waitlist for full days',
    'Text message reminders in French',
    'Body chart drawing on iPad (e.g. back, knee)',
    'Works with Node.js and React.js',
    'I use v2.5 of the app',
    'Sentence one. Sentence two.',
    'Billing & Payments',
    '',
  ]) {
    test(`does not flag: ${JSON.stringify(text)}`, () => assert.equal(security.looksLikeSpam(text), false));
  }

  test('checks every piece of text given', () => {
    assert.equal(security.looksLikeSpam('fine title', 'fine description', 'www.spam.com'), true);
    assert.equal(security.looksLikeSpam('fine title', 'fine description'), false);
  });
});

describe('hashIp() — scrambled IP addresses', () => {
  test('is the same for the same address and different for different addresses', () => {
    assert.equal(security.hashIp('203.0.113.5'), security.hashIp('203.0.113.5'));
    assert.notEqual(security.hashIp('203.0.113.5'), security.hashIp('203.0.113.6'));
  });

  test('does not contain the address and is a short hex fingerprint', () => {
    const hash = security.hashIp('203.0.113.5');
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.ok(!hash.includes('203'));
  });

  test('depends on the private secret (not just a plain hash anyone could reproduce)', () => {
    const plain = crypto.createHash('sha256').update('203.0.113.5').digest('hex').slice(0, 16);
    assert.notEqual(security.hashIp('203.0.113.5'), plain);
  });
});

describe('securityHeaders() — browser safety rules', () => {
  const run = (urlPath, { secure = false } = {}) => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    let called = false;
    security.securityHeaders({ path: urlPath, secure }, res, () => { called = true; });
    assert.ok(called, 'must continue to the next step');
    return headers;
  };

  test('the public board gets a strict content policy and may be embedded', () => {
    const csp = run('/')['Content-Security-Policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors \*/);
  });

  test('scripts typed into the page cannot run: no unsafe-inline for scripts', () => {
    const csp = run('/')['Content-Security-Policy'];
    const scriptRule = csp.split(';').find((r) => r.trim().startsWith('script-src'));
    assert.ok(!scriptRule.includes('unsafe-inline') && !scriptRule.includes('unsafe-eval'));
  });

  test('the admin page and admin data can never be shown inside another site', () => {
    for (const p of ['/admin.html', '/admin', '/api/admin/stats']) {
      const h = run(p);
      assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/, p);
      assert.equal(h['X-Frame-Options'], 'DENY', p);
      assert.equal(h['Cache-Control'], 'no-store', p);
      assert.equal(h['X-Robots-Tag'], 'noindex', p);
    }
  });

  test('every page: no content-type guessing, limited referrer, no camera/microphone/location', () => {
    const h = run('/');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.match(h['Permissions-Policy'], /camera=\(\)/);
    assert.equal(h['X-Frame-Options'], undefined); // only the admin side sets it
  });

  test('asks browsers to always use https, but only on https connections', () => {
    assert.ok(run('/', { secure: true })['Strict-Transport-Security']);
    assert.equal(run('/', { secure: false })['Strict-Transport-Security'], undefined);
  });
});
