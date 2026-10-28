// ============================================================================
// tests/admin-api.test.js — what INTERNAL STAFF can do (and what everyone else can't)
// ----------------------------------------------------------------------------
// Requirement: the list/dashboard of all suggestions is for internal staff only.
// ============================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

let s, a;
before(async () => { s = await startServer(); await s.setApproval(false); a = await s.admin(); });
after(async () => { await s.stop(); s.cleanup(); });
const ip = (n) => ({ ip: `10.30.${n}.1` });

const ADMIN_ROUTES = [
  ['GET', '/api/admin/me'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/settings'],
  ['PATCH', '/api/admin/settings'], ['GET', '/api/admin/pending'], ['GET', '/api/admin/ideas'],
  ['GET', '/api/admin/ideas/1'], ['PATCH', '/api/admin/ideas/1'], ['DELETE', '/api/admin/ideas/1'],
  ['POST', '/api/admin/ideas/1/approve'], ['POST', '/api/admin/ideas/1/merge'],
  ['POST', '/api/admin/ideas/1/comments'], ['DELETE', '/api/admin/votes/1'],
  ['POST', '/api/admin/comments/1/approve'], ['DELETE', '/api/admin/comments/1'],
  ['POST', '/api/admin/categories'], ['PATCH', '/api/admin/categories/1'], ['DELETE', '/api/admin/categories/1'],
  ['GET', '/api/admin/export/ideas.csv'], ['GET', '/api/admin/ideas/1/voters.csv'],
];

describe('access control: staff only', () => {
  for (const [method, url] of ADMIN_ROUTES) {
    test(`${method} ${url} refuses visitors who are not logged in`, async () => {
      const res = await s.req(method, url, { body: method === 'GET' ? undefined : {}, ip: ip(1).ip });
      assert.equal(res.status, 401);
    });
  }

  test('a made-up or tampered cookie does not work', async () => {
    for (const cookie of ['fb_admin=abc', 'fb_admin=', 'fb_admin=' + 'a'.repeat(64), 'other=1']) {
      assert.equal((await s.get('/api/admin/stats', { cookie, ...ip(1) })).status, 401, cookie);
    }
  });

  test('wrong password, empty password and wrong types are refused', async () => {
    for (const password of ['nope', '', undefined, 123, null, { a: 1 }, ADMIN_PASSWORD + 'x', ADMIN_PASSWORD.toUpperCase()]) {
      const res = await s.post('/api/admin/login', { password }, ip(2));
      assert.equal(res.status, 401, JSON.stringify(password));
      assert.equal(res.headers.get('set-cookie'), null);
    }
  });

  test('login sets a safe cookie: HttpOnly, SameSite=Strict, ~7 days', async () => {
    const res = await s.post('/api/admin/login', { password: ADMIN_PASSWORD }, ip(3));
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=604800/);
  });

  test('logging out ends the session', async () => {
    const login = await s.post('/api/admin/login', { password: ADMIN_PASSWORD }, ip(4));
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await s.get('/api/admin/me', { cookie, ...ip(4) })).status, 200);
    await s.post('/api/admin/logout', {}, { cookie, ...ip(4) });
    assert.equal((await s.get('/api/admin/me', { cookie, ...ip(4) })).status, 401);
  });

  test('admin responses are never cached', async () => {
    const res = await a.get('/api/admin/stats');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('too many wrong passwords from one address get blocked (10 per 15 minutes)', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await s.post('/api/admin/login', { password: 'bad' }, { ip: '10.30.99.9' });
    assert.equal(last.status, 429);
    // ...even the right password is refused from that address while blocked
    assert.equal((await s.post('/api/admin/login', { password: ADMIN_PASSWORD }, { ip: '10.30.99.9' })).status, 429);
  });
});

describe('dashboard data', () => {
  test('stats count published ideas, votes and people; breakdowns add up', async () => {
    const before = (await a.get('/api/admin/stats')).json;
    const idea = await s.makeIdea({ title: 'Stats test idea', email: 'stat1@example.com' }, ip(10));
    await s.vote(idea.id, 'stat2@example.com', 'Stat Two', ip(11));
    const after = (await a.get('/api/admin/stats')).json;
    assert.equal(after.totals.ideas, before.totals.ideas + 1);
    assert.equal(after.totals.votes, before.totals.votes + 2);
    assert.equal(after.totals.people, before.totals.people + 2);
    assert.equal(after.byStatus.reduce((n, x) => n + x.count, 0), after.totals.ideas);
    assert.equal(after.byCategory.reduce((n, x) => n + x.ideas, 0), after.totals.ideas);
    assert.equal(after.byCategory.reduce((n, x) => n + x.votes, 0), after.totals.votes);
  });

  test('the full list includes private details and is sorted by votes', async () => {
    const low = await s.makeIdea({ title: 'Admin list low votes' }, ip(12));
    const high = await s.makeIdea({ title: 'Admin list many votes', email: 'owner@example.com' }, ip(13));
    await s.addVotes(high.id, 3);
    const list = (await a.get('/api/admin/ideas')).json;
    assert.ok(list.find((i) => i.id === high.id).author_email === 'owner@example.com');
    const votes = list.map((i) => i.vote_count);
    assert.deepEqual(votes, [...votes].sort((x, y) => y - x));
    assert.ok(list.findIndex((i) => i.id === high.id) < list.findIndex((i) => i.id === low.id));
  });

  test('one idea shows every voter with name and email', async () => {
    const idea = await s.makeIdea({ title: 'Voter list idea', name: 'Owner', email: 'o@example.com' }, ip(14));
    await s.vote(idea.id, 'second@example.com', 'Second', ip(15));
    const d = (await a.get(`/api/admin/ideas/${idea.id}`)).json;
    assert.deepEqual(d.voters.map((v) => v.email).sort(), ['o@example.com', 'second@example.com']);
    assert.equal(d.author_email, 'o@example.com');
  });

  test('"same_network" flags several voters from one address', async () => {
    const idea = await s.makeIdea({ title: 'Network flag idea' }, ip(16));
    await s.vote(idea.id, 'x1@example.com', 'X1', ip(17));
    await s.vote(idea.id, 'x2@example.com', 'X2', ip(17));
    const d = (await a.get(`/api/admin/ideas/${idea.id}`)).json;
    assert.equal(d.voters.find((v) => v.email === 'x1@example.com').same_network, 1);
    assert.equal(d.voters.find((v) => v.email === 'o@example.com' || v.email === 'person@example.com').same_network, 0);
  });

  test('unknown idea gives 404', async () => {
    assert.equal((await a.get('/api/admin/ideas/999999')).status, 404);
  });
});

describe('managing ideas', () => {
  test('changing the status shows on the public board', async () => {
    const idea = await s.makeIdea({ title: 'Status change idea' }, ip(20));
    const res = await a.patch(`/api/admin/ideas/${idea.id}`, { status: 'planned' });
    assert.equal(res.status, 200);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.status, 'planned');
    assert.ok((await s.get('/api/ideas?status=planned')).json.some((i) => i.id === idea.id));
  });

  test('editing the title and category works; the customer-facing similar matching follows the new title', async () => {
    const idea = await s.makeIdea({ title: 'Typo titel here' }, ip(21));
    const cat = (await s.get('/api/meta')).json.categories[0];
    const res = await a.patch(`/api/admin/ideas/${idea.id}`, { title: 'Recurring invoices', category_id: cat.id });
    assert.equal(res.json.title, 'Recurring invoices');
    assert.equal(res.json.category_id, cat.id);
    const sim = (await s.get('/api/similar?title=recurring+invoice', ip(22))).json;
    assert.ok(sim.matches.some((m) => m.id === idea.id));
  });

  test('rejects unknown statuses, short titles, bad categories (nothing changes)', async () => {
    const idea = await s.makeIdea({ title: 'Validation target idea' }, ip(23));
    for (const body of [{ status: 'banana' }, { title: 'abc' }, { category_id: 999999 }, { category_id: 'abc' }, { category_id: 1.5 }]) {
      assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, body)).status, 400, JSON.stringify(body));
    }
    const now = (await s.get(`/api/ideas/${idea.id}`)).json;
    assert.equal(now.title, 'Validation target idea');
    assert.equal(now.status, 'under_review');
  });

  test('can clear the category', async () => {
    const cat = (await s.get('/api/meta')).json.categories[0];
    const idea = await s.makeIdea({ title: 'Clear category idea', category_id: cat.id }, ip(24));
    const res = await a.patch(`/api/admin/ideas/${idea.id}`, { category_id: null });
    assert.equal(res.json.category_id, null);
  });

  test('deleting an idea removes it with its votes and comments', async () => {
    const idea = await s.makeIdea({ title: 'Delete me idea' }, ip(25));
    await s.comment(idea.id, 'a comment', {}, ip(25));
    assert.equal((await a.del(`/api/admin/ideas/${idea.id}`)).status, 200);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).status, 404);
    const db = s.openDb();
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM votes WHERE idea_id = ?').get(idea.id).n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM comments WHERE idea_id = ?').get(idea.id).n, 0);
    } finally { db.close(); }
  });

  test('removing a single suspicious vote lowers the count', async () => {
    const idea = await s.makeIdea({ title: 'Fake vote idea' }, ip(26));
    await s.vote(idea.id, 'fake@example.com', 'Fake', ip(27));
    const d = (await a.get(`/api/admin/ideas/${idea.id}`)).json;
    const fake = d.voters.find((v) => v.email === 'fake@example.com');
    await a.del(`/api/admin/votes/${fake.id}`);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.vote_count, 1);
  });

  test('team replies are published and marked as from the team', async () => {
    const idea = await s.makeIdea({ title: 'Reply target idea' }, ip(28));
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/comments`, { body: '  We are on it  ' })).status, 201);
    const c = (await s.get(`/api/ideas/${idea.id}`)).json.comments.at(-1);
    assert.deepEqual([c.body, c.is_admin, c.name], ['We are on it', 1, 'Team']);
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/comments`, { body: '   ' })).status, 400);
    assert.equal((await a.post('/api/admin/ideas/999999/comments', { body: 'hi' })).status, 404);
  });

  test('deleting a comment removes it', async () => {
    const idea = await s.makeIdea({ title: 'Comment delete idea' }, ip(29));
    await s.comment(idea.id, 'remove this', {}, ip(29));
    const id = (await a.get(`/api/admin/ideas/${idea.id}`)).json.comments[0].id;
    assert.equal((await a.del(`/api/admin/comments/${id}`)).status, 200);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.comments.length, 0);
  });
});

describe('merging duplicates', () => {
  test('moves votes (each person once) and comments, then removes the duplicate', async () => {
    const keep = await s.makeIdea({ title: 'Merge keep idea', name: 'A', email: 'a@merge.com' }, ip(30));
    const dupe = await s.makeIdea({ title: 'Merge duplicate wording', name: 'B', email: 'b@merge.com' }, ip(31));
    await s.vote(dupe.id, 'a@merge.com', 'A', ip(32));      // A voted on both: counts once
    await s.vote(dupe.id, 'c@merge.com', 'C', ip(33));
    await s.comment(dupe.id, 'comment on dupe', {}, ip(34));
    const res = await a.post(`/api/admin/ideas/${dupe.id}/merge`, { into_id: keep.id });
    assert.equal(res.status, 200);
    assert.equal(res.json.vote_count, 3); // a, b, c
    assert.equal((await s.get(`/api/ideas/${dupe.id}`)).status, 404);
    const comments = (await s.get(`/api/ideas/${keep.id}`)).json.comments.map((c) => c.body);
    assert.ok(comments.includes('comment on dupe'));
    assert.ok(comments.some((b) => /Merged in a similar suggestion/.test(b)));
  });

  test('refuses to merge into itself, into a missing idea, or with a bad id', async () => {
    const idea = await s.makeIdea({ title: 'Merge self idea' }, ip(35));
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/merge`, { into_id: idea.id })).status, 400);
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/merge`, { into_id: 999999 })).status, 404);
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/merge`, {})).status, 404);
    assert.equal((await a.post(`/api/admin/ideas/999999/merge`, { into_id: idea.id })).status, 404);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).status, 200);
  });
});

describe('categories', () => {
  test('add, rename, and delete (ideas become uncategorized)', async () => {
    const created = await a.post('/api/admin/categories', { name: '  Reports  ' });
    assert.equal(created.status, 201);
    assert.equal(created.json.name, 'Reports');
    const id = created.json.id;
    assert.equal((await a.patch(`/api/admin/categories/${id}`, { name: 'Reporting' })).status, 200);
    assert.ok((await s.get('/api/meta')).json.categories.some((c) => c.name === 'Reporting'));
    const idea = await s.makeIdea({ title: 'Category delete idea', category_id: id }, ip(40));
    assert.equal((await a.del(`/api/admin/categories/${id}`)).status, 200);
    const now = (await s.get(`/api/ideas/${idea.id}`)).json;
    assert.equal(now.category_id, null);
  });

  test('duplicate and blank names are refused', async () => {
    assert.equal((await a.post('/api/admin/categories', { name: 'Scheduling' })).status, 400);
    assert.equal((await a.post('/api/admin/categories', { name: '   ' })).status, 400);
    assert.equal((await a.patch('/api/admin/categories/1', { name: 'Forms' })).status, 400);
  });
});

describe('CSV exports', () => {
  test('ideas.csv downloads with a header row and escapes commas and quotes', async () => {
    await s.makeIdea({ title: 'Comma, "quote" idea' }, ip(50));
    const res = await a.get('/api/admin/export/ideas.csv');
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.match(res.text, /^id,title,description,category,status,vote_count/);
    assert.ok(res.text.includes('"Comma, ""quote"" idea"'));
  });

  test('spreadsheet formulas are neutralised', async () => {
    await s.makeIdea({ title: '=HYPERLINK("x") formula idea', name: '+cmd' }, ip(51));
    const res = await a.get('/api/admin/export/ideas.csv');
    assert.ok(!/(^|,|\n)=HYPERLINK/.test(res.text), 'a cell must not start with =');
    assert.ok(res.text.includes(`'=HYPERLINK`));
  });

  test('voters.csv lists voters of one idea', async () => {
    const idea = await s.makeIdea({ title: 'Voters csv idea', email: 'csv@example.com' }, ip(52));
    const res = await a.get(`/api/admin/ideas/${idea.id}/voters.csv`);
    assert.match(res.text, /^name,email,created_at/);
    assert.ok(res.text.includes('csv@example.com'));
  });
});

describe('adding a request on a customer\'s behalf', () => {
  const ipN = (n) => ({ ip: `10.31.${n}.1` });
  const add = (body) => a.post('/api/admin/ideas', body);

  test('needs staff login', async () => {
    assert.equal((await s.post('/api/admin/ideas', { title: 'Sneaky request' }, ipN(1))).status, 401);
  });

  test('only a title is required: it is published at once, counts as 1 request, credited to the team', async () => {
    const res = await add({ title: 'Print client summaries' });
    assert.equal(res.status, 201);
    const idea = res.json.idea;
    assert.equal(idea.author_name, 'The team');
    assert.equal((await a.get(`/api/admin/ideas/${idea.id}`)).json.author_email, '');
    assert.equal(idea.vote_count, 1);
    assert.equal(idea.status, 'under_review');
    // visible on the public board straight away, with no email anywhere
    const pub = (await s.get(`/api/ideas/${idea.id}`)).json;
    assert.equal(pub.vote_count, 1);
    assert.ok(!JSON.stringify(pub).includes('invalid') && !JSON.stringify(pub).includes('@'));
  });

  test('with everything filled in: name, email, details, category and status are all saved', async () => {
    const cat = (await s.get('/api/meta')).json.categories[0];
    const res = await add({ title: '  Group booking  ', description: 'Phone call', name: ' Dana Lee ', email: ' Dana@Clinic.CA ', category_id: cat.id, status: 'planned' });
    assert.equal(res.status, 201);
    const d = (await a.get(`/api/admin/ideas/${res.json.idea.id}`)).json;
    assert.deepEqual([d.title, d.description, d.author_name, d.author_email, d.category_id, d.status],
      ['Group booking', 'Phone call', 'Dana Lee', 'dana@clinic.ca', cat.id, 'planned']);
    assert.deepEqual(d.voters.map((v) => v.email), ['dana@clinic.ca']);
  });

  test('a name without an email is kept; an email without a name works too', async () => {
    const one = (await add({ title: 'Name only request', name: 'Sam' })).json.idea;
    assert.equal(one.author_name, 'Sam');
    const two = (await add({ title: 'Email only request', email: 'x@y.com' })).json.idea;
    assert.equal(two.author_name, 'The team');
    assert.equal((await a.get(`/api/admin/ideas/${two.id}`)).json.author_email, 'x@y.com');
  });

  test('blank name and email (spaces, null) are treated as not given', async () => {
    const res = await add({ title: 'Blank extras request', name: '   ', email: '  ', description: null, category_id: null });
    assert.equal(res.status, 201);
    assert.equal(res.json.idea.author_name, 'The team');
  });

  test('rejects: short or missing title, a bad email (if one is given), bad status or category', async () => {
    for (const body of [
      {}, { title: 'abc' }, { title: '    ' }, { title: ['a list'] },
      { title: 'Valid title here', email: 'not-an-email' }, { title: 'Valid title here', email: 'a@b' },
      { title: 'Valid title here', status: 'banana' },
      { title: 'Valid title here', category_id: 999999 }, { title: 'Valid title here', category_id: 'abc' },
    ]) {
      assert.equal((await add(body)).status, 400, JSON.stringify(body));
    }
  });

  test('several requests with no email are all kept (each counts separately, none are lost)', async () => {
    const x = (await add({ title: 'Repeated anonymous ask' })).json.idea;
    const y = (await add({ title: 'Repeated anonymous ask again' })).json.idea;
    assert.notEqual(x.id, y.id);
    const stats = (await a.get('/api/admin/stats')).json.totals;
    assert.ok(stats.votes >= 2);
  });

  test('merging two anonymous requests keeps both counts', async () => {
    const keep = (await add({ title: 'Merge anon keep' })).json.idea;
    const dupe = (await add({ title: 'Merge anon duplicate' })).json.idea;
    const merged = await a.post(`/api/admin/ideas/${dupe.id}/merge`, { into_id: keep.id });
    assert.equal(merged.json.vote_count, 2);
  });

  test('requests without an email do not count as extra "people" in the dashboard', async () => {
    const before = (await a.get('/api/admin/stats')).json.totals;
    await add({ title: 'People count anon request' });
    const after = (await a.get('/api/admin/stats')).json.totals;
    assert.equal(after.votes, before.votes + 1);
    assert.equal(after.ideas, before.ideas + 1);
    assert.equal(after.people, before.people);
  });

  test('staff see "no email" for those voters, and the voter CSV and exports contain no placeholder', async () => {
    const idea = (await add({ title: 'No email shown request' })).json.idea;
    const d = (await a.get(`/api/admin/ideas/${idea.id}`)).json;
    assert.deepEqual(d.voters.map((v) => v.email), ['']);
    const csv = (await a.get(`/api/admin/ideas/${idea.id}/voters.csv`)).text;
    assert.ok(!csv.includes('no-email.invalid'));
    assert.ok(!(await a.get('/api/admin/export/ideas.csv')).text.includes('no-email.invalid'));
  });

  test('the new request is counted by "similar" matching, and the reply lists similar existing ideas', async () => {
    const first = (await add({ title: 'Quantum widget exports', name: 'A' })).json;
    assert.equal(first.similar.matches.length, 0);
    const second = (await add({ title: 'Export quantum widgets' })).json;
    assert.ok(second.similar.matches.some((m) => m.id === first.idea.id));
    assert.ok(second.similar.people >= 1);
    // customers now see it too
    const sim = (await s.get('/api/similar?title=quantum+widget+export', ipN(20))).json;
    assert.ok(sim.matches.length >= 2);
  });

  test('a customer can still vote on it, and removing their vote leaves the staff-logged vote', async () => {
    const idea = (await add({ title: 'Customers can join this' })).json.idea;
    assert.equal((await s.vote(idea.id, 'cust@example.com', 'Cust', ipN(21))).json.vote_count, 2);
    assert.equal((await s.vote(idea.id, 'cust@example.com', 'Cust', ipN(21))).json.vote_count, 1);
  });

  test('a request containing a web link is accepted (staff are trusted) and published', async () => {
    const res = await add({ title: 'Integrate with example.com', description: 'see https://example.com/docs' });
    assert.equal(res.status, 201);
    assert.equal((await s.get(`/api/ideas/${res.json.idea.id}`)).status, 200);
  });
});

describe('adjusting votes and the submitted date (for requests moved over from another tool)', () => {
  const ipN = (n) => ({ ip: `10.32.${n}.1` });
  const fresh = async (title, extra = {}) => (await a.post('/api/admin/ideas', { title, ...extra })).json.idea;
  const publicOf = async (id) => (await s.get(`/api/ideas/${id}`)).json;
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('extra votes are added to the real votes everywhere customers look', async () => {
    const idea = await fresh('Automated waitlist notices');
    assert.equal(idea.vote_count, 1);
    const res = await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: 12 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.vote_count, res.json.real_votes, res.json.vote_adjustment], [13, 1, 12]);
    assert.equal((await publicOf(idea.id)).vote_count, 13);
    assert.equal((await s.get('/api/ideas')).json.find((i) => i.id === idea.id).vote_count, 13);
  });

  test('a customer vote adds 1 on top, and removing it takes 1 off', async () => {
    const idea = await fresh('Adjusted then voted', { vote_adjustment: 4 });
    assert.equal(idea.vote_count, 5);
    assert.equal((await s.vote(idea.id, 'v1@example.com', 'V', ipN(1))).json.vote_count, 6);
    assert.equal((await s.vote(idea.id, 'v1@example.com', 'V', ipN(1))).json.vote_count, 5);
  });

  test('ranking uses the adjusted total', async () => {
    const low = await fresh('Rank low idea here');
    const high = await fresh('Rank high idea here', { vote_adjustment: 50 });
    const list = (await s.get('/api/ideas')).json.map((i) => i.id);
    assert.ok(list.indexOf(high.id) < list.indexOf(low.id));
  });

  test('the similar-ideas count shown to customers includes the extra votes', async () => {
    const idea = await fresh('Zebra crossing planner tool', { vote_adjustment: 9 });
    const sim = (await s.get('/api/similar?title=zebra+crossing+planner', ipN(2))).json;
    assert.ok(sim.matches.some((m) => m.id === idea.id && m.vote_count === 10));
    assert.ok(sim.people >= 10);
  });

  test('the admin sees the split between real voters and extra votes; the voter list stays real', async () => {
    const idea = await fresh('Split view idea', { vote_adjustment: 7 });
    const d = (await a.get(`/api/admin/ideas/${idea.id}`)).json;
    assert.deepEqual([d.vote_count, d.real_votes, d.vote_adjustment, d.voters.length], [8, 1, 7, 1]);
  });

  test('customers never see the split or the adjustment field', async () => {
    const idea = await fresh('Private split idea', { vote_adjustment: 3 });
    const pub = await publicOf(idea.id);
    assert.ok(!('vote_adjustment' in pub) && !('real_votes' in pub));
    for (const i of (await s.get('/api/ideas')).json) assert.ok(!('vote_adjustment' in i) && !('real_votes' in i));
  });

  test('negative adjustments lower the total but it never shows below 0', async () => {
    const idea = await fresh('Negative adjust idea', { vote_adjustment: 3 });
    assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: -1 })).json.vote_count, 0);
    assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: -500 })).json.vote_count, 0);
    assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: 0 })).json.vote_count, 1);
  });

  test('accepts numbers typed as text, rejects anything else', async () => {
    const idea = await fresh('Text number idea');
    assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: '5' })).json.vote_adjustment, 5);
    for (const bad of ['abc', '1.5', 1.5, '5 votes', 100001, -10001, {}, [3], true, '1e3', '0x10']) {
      assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { vote_adjustment: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await a.get(`/api/admin/ideas/${idea.id}`)).json.vote_adjustment, 5);
  });

  test('leaving the votes field out of an edit keeps the existing extra votes', async () => {
    const idea = await fresh('Edit keeps votes', { vote_adjustment: 6 });
    await a.patch(`/api/admin/ideas/${idea.id}`, { status: 'planned' });
    await a.patch(`/api/admin/ideas/${idea.id}`, { title: 'Edit keeps votes renamed' });
    assert.equal((await a.get(`/api/admin/ideas/${idea.id}`)).json.vote_adjustment, 6);
  });

  test('the submitted date can be changed and drives the "time ago" and the "newest" order', async () => {
    const old = await fresh('Old imported request', {});
    const newer = await fresh('Newer imported request', {});
    const res = await a.patch(`/api/admin/ideas/${old.id}`, { created_date: '2026-01-15' });
    assert.equal(res.status, 200);
    assert.equal(res.json.created_at, '2026-01-15 12:00:00');
    assert.equal((await publicOf(old.id)).created_at, '2026-01-15 12:00:00');
    const byNew = (await s.get('/api/ideas?sort=new')).json.map((i) => i.id);
    assert.ok(byNew.indexOf(newer.id) < byNew.indexOf(old.id));
  });

  test('saving without touching the date keeps the exact original time', async () => {
    const idea = await fresh('Date untouched idea');
    const before = (await a.get(`/api/admin/ideas/${idea.id}`)).json.created_at;
    await a.patch(`/api/admin/ideas/${idea.id}`, { created_date: before.slice(0, 10), title: 'Date untouched idea 2' });
    assert.equal((await a.get(`/api/admin/ideas/${idea.id}`)).json.created_at, before);
  });

  test('rejects dates that are not real, in the future, or too old', async () => {
    const idea = await fresh('Bad date idea');
    for (const bad of ['2026-02-31', '2026-13-01', 'yesterday', '15/01/2026', '2026-1-5', '1999-12-31', '2999-01-01', daysAgo(-3), '', '2026-01-15T10:00:00', 20260115, null, {}]) {
      const status = (await a.patch(`/api/admin/ideas/${idea.id}`, { created_date: bad })).status;
      assert.equal(status, 400, JSON.stringify(bad));
    }
  });

  test('today is accepted as a date', async () => {
    const idea = await fresh('Today date idea');
    assert.equal((await a.patch(`/api/admin/ideas/${idea.id}`, { created_date: daysAgo(0) })).status, 200);
  });

  test('adding a request can include its original date and votes so far', async () => {
    const res = await a.post('/api/admin/ideas', { title: 'Moved over request', created_date: '2026-03-10', vote_adjustment: 24, name: 'Dana', email: 'dana@clinic.ca' });
    assert.equal(res.status, 201);
    assert.deepEqual([res.json.idea.vote_count, res.json.idea.created_at], [25, '2026-03-10 12:00:00']);
    const d = (await a.get(`/api/admin/ideas/${res.json.idea.id}`)).json;
    assert.equal(d.voters[0].created_at, '2026-03-10 12:00:00');
  });

  test('adding a request with blank date and votes behaves as before', async () => {
    const res = await a.post('/api/admin/ideas', { title: 'Blank extras again', created_date: '', vote_adjustment: '' });
    assert.equal(res.status, 201);
    assert.equal(res.json.idea.vote_count, 1);
    assert.equal(res.json.idea.created_at.slice(0, 10), daysAgo(0));
  });

  test('adding a request rejects a bad date or votes (nothing is created)', async () => {
    const before = (await a.get('/api/admin/ideas')).json.length;
    for (const body of [{ created_date: '2026-02-30' }, { created_date: '2999-01-01' }, { vote_adjustment: 'lots' }, { vote_adjustment: -5 + 'x' }, { vote_adjustment: 1.5 }]) {
      assert.equal((await a.post('/api/admin/ideas', { title: 'Should not be created', ...body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await a.get('/api/admin/ideas')).json.length, before);
  });

  test('merging carries the extra votes across', async () => {
    const keep = await fresh('Merge extras keep', { vote_adjustment: 10 });
    const dupe = await fresh('Merge extras duplicate', { vote_adjustment: 5 });
    const merged = await a.post(`/api/admin/ideas/${dupe.id}/merge`, { into_id: keep.id });
    assert.deepEqual([merged.json.vote_count, merged.json.vote_adjustment, merged.json.real_votes], [17, 15, 2]);
  });

  test('dashboard totals and category breakdown include extra votes', async () => {
    const cat = (await s.get('/api/meta')).json.categories.find((c) => c.name === 'Forms');
    const before = (await a.get('/api/admin/stats')).json;
    const beforeForms = before.byCategory.find((c) => c.name === 'Forms')?.votes || 0;
    await fresh('Stats extras idea', { vote_adjustment: 20, category_id: cat.id });
    const after = (await a.get('/api/admin/stats')).json;
    assert.equal(after.totals.votes, before.totals.votes + 21);
    assert.equal(after.byCategory.find((c) => c.name === 'Forms').votes, beforeForms + 21);
    assert.equal(after.byCategory.reduce((n, x) => n + x.votes, 0), after.totals.votes);
    assert.equal(after.totals.people, before.totals.people, 'extra votes are not extra people');
  });

  test('the CSV export shows the adjusted vote total', async () => {
    const idea = await fresh('CSV extras idea', { vote_adjustment: 8 });
    const row = (await a.get('/api/admin/export/ideas.csv')).text.split('\n').find((l) => l.includes('CSV extras idea'));
    assert.ok(row.includes(',9,'), row);
  });

  test('staff access only', async () => {
    assert.equal((await s.req('PATCH', '/api/admin/ideas/1', { body: { vote_adjustment: 5 }, ...ipN(30) })).status, 401);
  });
});
