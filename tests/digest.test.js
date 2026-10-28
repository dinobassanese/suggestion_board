// ============================================================================
// tests/digest.test.js — the daily summary email (digest.js)
// ----------------------------------------------------------------------------
// No real emails are sent: a "fake mailbox" stands in for the email provider
// and just remembers what it was asked to send.
// ============================================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-board-digest-'));
process.env.BRAND_DIR = path.join(__dirname, 'fixtures', 'brand');   // fixed test brand
process.env.DB_PATH = path.join(dir, 'data.db');   // must be set BEFORE loading db.js

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, setSetting, getSetting } = require('../db');
const digest = require('../digest');
const { startServer } = require('./helpers');

after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const quietLog = { log() {}, error() {} };
const config = (extra = {}) => ({
  host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', from: 'board@example.com',
  to: ['boss@example.com'], hour: 8, timeZone: 'UTC', publicUrl: 'https://board.example.com', ...extra,
});
function fakeMailbox({ fail = false } = {}) {
  const sent = [];
  return { sent, sendMail: async (m) => { if (fail) throw new Error('provider said no'); sent.push(m); } };
}
const sqlTime = (iso) => iso.slice(0, 19).replace('T', ' ');

let at;                                  // "now" for each test: 2026-10-09 06:00 UTC
beforeEach(() => {
  for (const t of ['votes', 'comments', 'ideas']) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM settings WHERE key LIKE 'digest_%'`);
  at = new Date('2026-10-09T06:00:00Z');
});
let n = 0;
function addIdea({ title = `Idea ${++n}`, approved = 1, when = '2026-10-09T05:00:00Z', name = 'Ann', votes = 1 } = {}) {
  const id = db.prepare(`INSERT INTO ideas (title, description, author_name, author_email, approved, created_at) VALUES (?, '', ?, 'a@x.com', ?, ?)`)
    .run(title, name, approved, sqlTime(when)).lastInsertRowid;
  for (let i = 0; i < votes; i++) {
    db.prepare(`INSERT INTO votes (idea_id, name, email, created_at) VALUES (?, 'v', ?, ?)`).run(id, `v${i}-${id}@x.com`, sqlTime(when));
  }
  return Number(id);
}
const newIdeasPart = (text) => text.split('MOST REQUESTED RIGHT NOW')[0];
const SINCE = '2026-10-08 06:00:00';

describe('settings', () => {
  test('reads settings from the environment, with sensible defaults', () => {
    const c = digest.readConfig({ SMTP_HOST: ' smtp.x.com ', SMTP_USER: 'me@x.com', SMTP_PASS: 'pw', DIGEST_TO: 'a@x.com, b@x.com ,' });
    assert.equal(c.host, 'smtp.x.com');
    assert.equal(c.port, 587);
    assert.deepEqual(c.to, ['a@x.com', 'b@x.com']);
    assert.equal(c.from, 'me@x.com');
    assert.equal(c.hour, 8);
    assert.equal(c.timeZone, 'UTC');
  });

  test('a bad hour falls back to 8', () => {
    for (const bad of ['25', '-1', 'abc', '8.5']) assert.equal(digest.readConfig({ DIGEST_HOUR: bad }).hour, 8, bad);
    assert.equal(digest.readConfig({ DIGEST_HOUR: '0' }).hour, 0);
    assert.equal(digest.readConfig({ DIGEST_HOUR: '23' }).hour, 23);
  });

  test('lists exactly what is missing', () => {
    assert.deepEqual(digest.missingSettings(digest.readConfig({})), ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'DIGEST_TO']);
    assert.deepEqual(digest.missingSettings(config()), []);
  });

  test('recognises valid and invalid time zones', () => {
    assert.equal(digest.isValidTimeZone('America/Toronto'), true);
    assert.equal(digest.isValidTimeZone('Mars/Olympus'), false);
  });

  test('works out the local day and hour in a time zone', () => {
    assert.deepEqual(digest.localDayAndHour(new Date('2026-10-09T12:00:00Z'), 'America/Toronto'), { day: '2026-10-09', hour: 8 });
    assert.deepEqual(digest.localDayAndHour(new Date('2026-10-09T03:00:00Z'), 'America/Toronto'), { day: '2026-10-08', hour: 23 });
    assert.deepEqual(digest.localDayAndHour(new Date('2026-10-09T00:30:00Z'), 'UTC'), { day: '2026-10-09', hour: 0 });
  });
});

describe('sending through Resend (web service, works where SMTP is blocked)', () => {
  const realFetch = global.fetch;
  let calls;
  const stubFetch = (status, body = {}) => {
    calls = [];
    global.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => body }; };
  };
  after(() => { global.fetch = realFetch; });
  const resendConfig = (extra = {}) => config({ resendKey: 're_test_key', host: '', user: '', pass: '', from: 'Feature Board <board@example.com>', ...extra });

  test('reads RESEND_API_KEY and needs only key + from + recipient', () => {
    const c = digest.readConfig({ RESEND_API_KEY: ' re_abc \n', DIGEST_FROM: 'board@example.com', DIGEST_TO: 'a@x.com' });
    assert.equal(c.resendKey, 're_abc');
    assert.deepEqual(digest.missingSettings(c), []);
    assert.deepEqual(digest.missingSettings(digest.readConfig({ RESEND_API_KEY: 're_abc', DIGEST_TO: 'a@x.com' })), ['DIGEST_FROM']);
    assert.deepEqual(digest.missingSettings(digest.readConfig({ RESEND_API_KEY: 're_abc', DIGEST_FROM: 'b@x.com' })), ['DIGEST_TO']);
  });

  test('posts the email to Resend with the key, recipients, text and HTML', async () => {
    stubFetch(200, { id: 'abc' });
    addIdea({ title: 'Via Resend' });
    const r = await digest.sendDigest({ config: resendConfig({ to: ['a@x.com', 'b@x.com'] }), now: at });
    assert.equal(r.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
    assert.deepEqual(calls[0].body.to, ['a@x.com', 'b@x.com']);
    assert.equal(calls[0].body.from, 'Feature Board <board@example.com>');
    assert.ok(calls[0].body.text.includes('Via Resend') && calls[0].body.html.includes('Via Resend'));
    assert.match(calls[0].body.subject, /1 new idea/);
  });

  test('a refusal from Resend becomes a readable error (without the API key)', async () => {
    stubFetch(403, { message: 'The example.com domain is not verified.' });
    addIdea();
    await assert.rejects(
      digest.sendDigest({ config: resendConfig(), now: at }),
      (err) => /403/.test(err.message) && /not verified/.test(err.message) && !err.message.includes('re_test_key'));
  });

  test('a refusal with no details still gives a useful error', async () => {
    global.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    addIdea();
    await assert.rejects(digest.sendDigest({ config: resendConfig(), now: at }), /500/);
  });

  test('a quiet day sends nothing through Resend', async () => {
    stubFetch(200);
    const r = await digest.sendDigest({ config: resendConfig(), now: at });
    assert.equal(r.sent, false);
    assert.equal(calls.length, 0);
  });

  test('the daily schedule works the same way through Resend', async () => {
    stubFetch(200);
    addIdea();
    const r = await digest.checkSchedule({ config: resendConfig(), now: new Date('2026-10-09T08:00:00Z'), log: quietLog });
    assert.equal(r.sent, true);
    assert.equal(calls.length, 1);
  });
});

describe('what goes in the email', () => {
  test('a quiet day gives nothing to send', () => {
    addIdea({ when: '2026-10-01T05:00:00Z' });          // old
    assert.equal(digest.buildDigest({ since: SINCE }), null);
  });

  test('new ideas are listed, with counts and a subject that says how many', () => {
    addIdea({ title: 'Print summaries' });
    addIdea({ title: 'Dark mode' });
    const d = digest.buildDigest({ since: SINCE, publicUrl: 'https://board.example.com' });
    assert.equal(d.counts.newIdeas, 2);
    assert.match(d.subject, /2 new ideas/);
    assert.ok(d.text.includes('Print summaries') && d.html.includes('Dark mode'));
    assert.ok(d.html.includes('https://board.example.com/admin.html'));
  });

  test('uses singular wording for one idea and mentions items waiting for approval', () => {
    addIdea({ approved: 0 });
    const d = digest.buildDigest({ since: SINCE });
    assert.match(d.subject, /1 new idea,/);
    assert.match(d.subject, /1 waiting for approval/);
    assert.match(d.text, /\[WAITING FOR APPROVAL\]/);
    assert.match(d.html, /Waiting for approval/);
  });

  test('waiting comments count towards "waiting for approval", and new comments make a day non-quiet', () => {
    const id = addIdea({ when: '2026-10-01T05:00:00Z' });
    db.prepare(`INSERT INTO comments (idea_id, name, email, body, approved, created_at) VALUES (?, 'c', '', 'hi', 0, ?)`).run(id, sqlTime('2026-10-09T01:00:00Z'));
    const d = digest.buildDigest({ since: SINCE });
    assert.equal(d.counts.newComments, 1);
    assert.equal(d.counts.waiting, 1);
  });

  test('team replies do not count as new customer comments', () => {
    const id = addIdea({ when: '2026-10-01T05:00:00Z' });
    db.prepare(`INSERT INTO comments (idea_id, name, body, is_admin, created_at) VALUES (?, 'Team', 'reply', 1, ?)`).run(id, sqlTime('2026-10-09T01:00:00Z'));
    assert.equal(digest.buildDigest({ since: SINCE }), null);
  });

  test('new votes on older published ideas make it a non-quiet day; votes on brand-new ideas are not double counted', () => {
    const old = addIdea({ when: '2026-10-01T05:00:00Z', votes: 1 });
    db.prepare(`INSERT INTO votes (idea_id, name, email, created_at) VALUES (?, 'n', 'new@x.com', ?)`).run(old, sqlTime('2026-10-09T02:00:00Z'));
    addIdea({ votes: 3 });                              // new idea with 3 votes of its own
    const d = digest.buildDigest({ since: SINCE });
    assert.equal(d.counts.newVotes, 1);
    assert.equal(d.counts.newIdeas, 1);
  });

  test('votes on ideas still waiting for approval are not reported', () => {
    const pending = addIdea({ when: '2026-10-01T05:00:00Z', approved: 0 });
    db.prepare(`INSERT INTO votes (idea_id, name, email, created_at) VALUES (?, 'n', 'new@x.com', ?)`).run(pending, sqlTime('2026-10-09T02:00:00Z'));
    assert.equal(digest.buildDigest({ since: SINCE }), null);
  });

  test('the "most requested" list shows the top 5 published ideas, most votes first, and hides unpublished ones', () => {
    for (let i = 1; i <= 7; i++) addIdea({ title: `Top ${i}`, votes: i });
    addIdea({ title: 'Hidden giant', votes: 50, approved: 0 });
    const d = digest.buildDigest({ since: SINCE });
    const section = d.text.split('MOST REQUESTED RIGHT NOW')[1];
    assert.ok(section.indexOf('Top 7') < section.indexOf('Top 6'));
    assert.ok(section.includes('Top 3') && !section.includes('Top 2'));
    assert.ok(!section.includes('Hidden giant'));
    assert.match(section, /Top 7 - 7 votes/);
    assert.match(section, /Top 3 - 3 votes/);
  });

  test('a long list is cut off with a "...and N more" note', () => {
    for (let i = 0; i < 20; i++) addIdea({ title: `Bulk ${i}` });
    const d = digest.buildDigest({ since: SINCE });
    assert.match(d.text, /\.\.\.and 5 more/);
    assert.equal(d.counts.newIdeas, 20);
  });

  test('HTML typed by customers is neutralised in the email (cannot inject links or scripts)', () => {
    addIdea({ title: '<script>alert(1)</script> & "quotes"', name: '<img src=x onerror=alert(2)>' });
    const d = digest.buildDigest({ since: SINCE });
    assert.ok(!d.html.includes('<script>') && !d.html.includes('<img src=x'));
    assert.ok(d.html.includes('&lt;script&gt;'));
    assert.ok(d.html.includes('&amp;'));
  });

  test('line breaks in a title cannot break the plain-text layout, and long titles are shortened', () => {
    addIdea({ title: 'Line one\nLine two\r\nBcc: evil@example.com ' + 'x'.repeat(300) });
    const d = digest.buildDigest({ since: SINCE });
    const line = d.text.split('\n').find((l) => l.startsWith('- Line one'));
    assert.ok(line && line.includes('Line two Bcc:') && line.length < 260);
  });

  test('no dashboard link when PUBLIC_URL is not set', () => {
    addIdea();
    const d = digest.buildDigest({ since: SINCE });
    assert.ok(!d.html.includes('Open Dashboard') && !d.text.includes('Open your dashboard'));
  });
});

describe('sending', () => {
  test('sends one email to every recipient with text and HTML', async () => {
    addIdea({ title: 'Send me' });
    const box = fakeMailbox();
    const r = await digest.sendDigest({ config: config({ to: ['a@x.com', 'b@x.com'] }), transport: box, now: at });
    assert.equal(r.sent, true);
    assert.equal(box.sent.length, 1);
    assert.equal(box.sent[0].to, 'a@x.com, b@x.com');
    assert.equal(box.sent[0].from, 'board@example.com');
    assert.ok(box.sent[0].text.includes('Send me') && box.sent[0].html.includes('Send me'));
  });

  test('does not send on a quiet day', async () => {
    const box = fakeMailbox();
    const r = await digest.sendDigest({ config: config(), transport: box, now: at });
    assert.deepEqual([r.sent, r.reason], [false, 'nothing new']);
    assert.equal(box.sent.length, 0);
  });

  test('does not send (and does not crash) when email settings are missing', async () => {
    addIdea();
    const box = fakeMailbox();
    const r = await digest.sendDigest({ config: config({ host: '', to: [] }), transport: box, now: at });
    assert.equal(r.sent, false);
    assert.match(r.reason, /SMTP_HOST, DIGEST_TO/);
    assert.equal(box.sent.length, 0);
  });

  test('first summary looks back 24 hours: older ideas are left out', async () => {
    addIdea({ title: 'Too old', when: '2026-10-07T20:00:00Z' });
    addIdea({ title: 'Recent one', when: '2026-10-09T02:00:00Z' });
    const box = fakeMailbox();
    await digest.sendDigest({ config: config(), transport: box, now: at });
    assert.ok(newIdeasPart(box.sent[0].text).includes('Recent one') && !newIdeasPart(box.sent[0].text).includes('Too old'));
  });

  test('a forced test send looks back 7 days', async () => {
    addIdea({ title: 'Five days ago', when: '2026-10-04T10:00:00Z' });
    const box = fakeMailbox();
    const r = await digest.sendDigest({ config: config(), transport: box, now: at, force: true });
    assert.equal(r.sent, true);
    assert.ok(box.sent[0].text.includes('Five days ago'));
  });

  test('a provider error is reported to the caller', async () => {
    addIdea();
    await assert.rejects(digest.sendDigest({ config: config(), transport: fakeMailbox({ fail: true }), now: at }), /provider said no/);
  });
});

describe('the daily schedule', () => {
  const run = (now, extra = {}) => digest.checkSchedule({ config: config(extra), transport: extra.transport, now, log: quietLog });

  test('waits until the chosen hour', async () => {
    addIdea();
    const box = fakeMailbox();
    const r = await digest.checkSchedule({ config: config({ hour: 8 }), transport: box, now: new Date('2026-10-09T07:59:00Z'), log: quietLog });
    assert.equal(r.ran, false);
    assert.equal(box.sent.length, 0);
  });

  test('sends once the hour arrives, and never twice on the same day', async () => {
    addIdea();
    const box = fakeMailbox();
    const cfg = config();
    const ten = new Date('2026-10-09T08:00:00Z');
    assert.equal((await digest.checkSchedule({ config: cfg, transport: box, now: ten, log: quietLog })).sent, true);
    for (const t of ['08:01', '09:30', '23:59']) {
      assert.equal((await digest.checkSchedule({ config: cfg, transport: box, now: new Date(`2026-10-09T${t}:00Z`), log: quietLog })).ran, false);
    }
    assert.equal(box.sent.length, 1);
  });

  test('still sends if the app was off at exactly 8:00 and starts later that day', async () => {
    addIdea();
    const box = fakeMailbox();
    const r = await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-09T15:20:00Z'), log: quietLog });
    assert.equal(r.sent, true);
  });

  test('a restart on the same day does not send again (the day is remembered in the database)', async () => {
    addIdea();
    const box = fakeMailbox();
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-09T08:00:00Z'), log: quietLog });
    // "restart": nothing is kept in memory between calls, only the database
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-09T08:05:00Z'), log: quietLog });
    assert.equal(box.sent.length, 1);
  });

  test('the next day sends a new summary containing only what is new since the last one', async () => {
    addIdea({ title: 'Yesterday idea', when: '2026-10-09T05:00:00Z' });
    const box = fakeMailbox();
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-09T08:00:00Z'), log: quietLog });
    addIdea({ title: 'Today idea', when: '2026-10-10T03:00:00Z' });
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-10T08:00:00Z'), log: quietLog });
    assert.equal(box.sent.length, 2);
    assert.ok(newIdeasPart(box.sent[1].text).includes('Today idea') && !newIdeasPart(box.sent[1].text).includes('Yesterday idea'));
  });

  test('quiet days send nothing, and the following busy day still covers everything since the last real email', async () => {
    addIdea({ title: 'Monday idea', when: '2026-10-09T05:00:00Z' });
    const box = fakeMailbox();
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-09T08:00:00Z'), log: quietLog });
    const quiet = await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-10T08:00:00Z'), log: quietLog });
    assert.deepEqual([quiet.ran, quiet.sent], [true, false]);
    addIdea({ title: 'Later idea', when: '2026-10-10T20:00:00Z' });
    await digest.checkSchedule({ config: config(), transport: box, now: new Date('2026-10-11T08:00:00Z'), log: quietLog });
    assert.equal(box.sent.length, 2);
    assert.ok(box.sent[1].text.includes('Later idea'));
  });

  test('a failed send is not retried every minute, and nothing is lost for the next day', async () => {
    addIdea({ title: 'Survives failure', when: '2026-10-09T05:00:00Z' });
    const bad = fakeMailbox({ fail: true });
    const first = await digest.checkSchedule({ config: config(), transport: bad, now: new Date('2026-10-09T08:00:00Z'), log: quietLog });
    assert.deepEqual([first.ran, first.sent], [true, false]);
    assert.equal((await digest.checkSchedule({ config: config(), transport: bad, now: new Date('2026-10-09T08:01:00Z'), log: quietLog })).ran, false);
    const good = fakeMailbox();
    await digest.checkSchedule({ config: config(), transport: good, now: new Date('2026-10-10T08:00:00Z'), log: quietLog });
    assert.ok(good.sent[0].text.includes('Survives failure'));
  });

  test('respects the time zone: 8am Toronto is 12:00 UTC', async () => {
    addIdea({ when: '2026-10-09T05:00:00Z' });
    const box = fakeMailbox();
    const cfg = config({ timeZone: 'America/Toronto' });
    assert.equal((await digest.checkSchedule({ config: cfg, transport: box, now: new Date('2026-10-09T11:59:00Z'), log: quietLog })).ran, false);
    assert.equal((await digest.checkSchedule({ config: cfg, transport: box, now: new Date('2026-10-09T12:00:00Z'), log: quietLog })).sent, true);
  });

  test('does nothing when email is not configured', async () => {
    addIdea();
    const r = await digest.checkSchedule({ config: config({ host: '' }), transport: fakeMailbox(), now: new Date('2026-10-09T09:00:00Z'), log: quietLog });
    assert.equal(r.ran, false);
  });

  test('starting the timer without settings does nothing', () => {
    const saved = { ...process.env };
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'DIGEST_TO']) delete process.env[k];
    const messages = [];
    assert.equal(digest.startDigestTimer({ log: (m) => messages.push(m), error() {} }), null);
    assert.match(messages[0], /off/);
    Object.assign(process.env, saved);
  });
});

describe('the "send a test" button in the dashboard API', () => {
  test('staff only, and a clear message when email is not set up', async () => {
    const s = await startServer();
    try {
      assert.equal((await s.post('/api/admin/digest/test', {}, { ip: '10.60.0.1' })).status, 401);
      const a = await s.admin();
      const res = await a.post('/api/admin/digest/test');
      assert.equal(res.status, 400);
      assert.match(res.json.error, /not set up yet.*SMTP_HOST/);
      const settings = (await a.get('/api/admin/settings')).json;
      assert.equal(settings.digest_enabled, false);
    } finally { await s.stop(); s.cleanup(); }
  });

  test('an email provider that refuses gives a friendly error with no secrets in it', async () => {
    const s = await startServer({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'u', SMTP_PASS: 'super-secret-pw', DIGEST_TO: 'boss@example.com' } });
    try {
      await s.setApproval(false);
      await s.makeIdea({ title: 'Idea for the test email' });
      const a = await s.admin();
      const res = await a.post('/api/admin/digest/test');
      assert.equal(res.status, 502);
      assert.match(res.json.error, /could not be sent/);
      const settings = (await a.get('/api/admin/settings')).json;
      assert.deepEqual([settings.digest_enabled, settings.digest_hour, settings.digest_timezone, settings.digest_to], [true, 8, 'UTC', 'boss@example.com']);
      assert.ok(!res.text.includes('super-secret-pw'));
      assert.ok(!s.output.includes('super-secret-pw'));
    } finally { await s.stop(); s.cleanup(); }
  });
});
