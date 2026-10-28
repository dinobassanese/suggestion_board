// ============================================================================
// tests/public-api.test.js — what CUSTOMERS can do
// ----------------------------------------------------------------------------
// Covers the project requirements:
//   1. customers can submit a suggestion (input + validation)
//   2. the suggestion is stored
//   3. similar suggestions are counted (votes) and ranked by that count
//   4. the customer is shown how many people asked for something similar
// plus voting, commenting, searching and privacy.
// These run against the real server with review-before-publishing switched off,
// so new ideas appear straight away. (Review mode has its own file.)
// ============================================================================

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s;
before(async () => { s = await startServer(); await s.setApproval(false); });
after(async () => { await s.stop(); s.cleanup(); });

// Give each group of tests its own "visitor address" so spam limits never interfere.
const ipFor = (n) => ({ ip: `10.20.${n}.1` });

describe('GET /api/meta', () => {
  test('gives the page its statuses, categories and a bot-check token', async () => {
    const { status, json } = await s.get('/api/meta');
    assert.equal(status, 200);
    assert.deepEqual(json.statuses.map((x) => x.key), ['under_review', 'planned', 'in_progress', 'done', 'not_planned']);
    assert.deepEqual(json.statuses.map((x) => x.label), ['Under review', 'Planned', 'In progress', 'Done', 'Not planned']);
    assert.equal(json.categories.length, 7);
    assert.deepEqual(json.categories.map((c) => c.name), [...json.categories.map((c) => c.name)].sort());
    assert.match(json.form_token, /^\d+\.[0-9a-f]{32}$/);
    assert.equal(json.turnstile_site_key, '');
  });
});

describe('submitting a suggestion', () => {
  test('is stored, returned with its first vote, and shows up on the board', async () => {
    const res = await s.postIdea({ title: 'Print appointment summaries', description: 'For clients without email.', name: 'Ann Lee', email: 'ann@clinic.ca' }, ipFor(1));
    assert.equal(res.status, 201);
    const { idea, pending, similar } = res.json;
    assert.equal(pending, false);
    assert.equal(idea.title, 'Print appointment summaries');
    assert.equal(idea.description, 'For clients without email.');
    assert.equal(idea.status, 'under_review');
    assert.equal(idea.vote_count, 1, 'the person who posts counts as the first vote');
    assert.equal(idea.has_voted, true);
    assert.equal(idea.comment_count, 0);
    assert.deepEqual(similar, { matches: [], people: 0 });

    const list = (await s.get('/api/ideas')).json;
    assert.ok(list.some((i) => i.id === idea.id));
  });

  test('is really saved in the database, with the email lower-cased and the IP address scrambled', async () => {
    const idea = await s.makeIdea({ title: 'Stored properly', email: 'Mixed.Case@Clinic.CA', name: '  Padded Name  ' }, { ip: '203.0.113.77' });
    const db = s.openDb();
    const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id);
    const vote = db.prepare('SELECT * FROM votes WHERE idea_id = ?').get(idea.id);
    db.close();
    assert.equal(row.author_email, 'mixed.case@clinic.ca');
    assert.equal(row.author_name, 'Padded Name');
    assert.equal(vote.email, 'mixed.case@clinic.ca');
    assert.match(row.ip_hash, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(row).includes('203.0.113.77'), 'raw IP address must never be stored');
  });

  test('trims spaces around the title and keeps the category', async () => {
    const meta = (await s.get('/api/meta')).json;
    const forms = meta.categories.find((c) => c.name === 'Forms');
    const idea = await s.makeIdea({ title: '   Save forms halfway   ', category_id: forms.id });
    assert.equal(idea.title, 'Save forms halfway');
    assert.equal(idea.category, 'Forms');
    assert.equal(idea.category_id, forms.id);
  });

  test('works without a category or description', async () => {
    const idea = await s.makeIdea({ title: 'No extras here' });
    assert.equal(idea.category, null);
    assert.equal(idea.description, '');
  });

  test('cuts over-long text to the allowed length instead of storing it all', async () => {
    const idea = await s.makeIdea({ title: 'T'.repeat(300), description: 'D'.repeat(5000), name: 'N'.repeat(200) });
    assert.equal(idea.title.length, 120);
    assert.equal(idea.description.length, 2000);
    assert.equal(idea.author_name.length, 60);
  });

  test('accepts exactly the shortest allowed title (4 characters)', async () => {
    assert.equal((await s.postIdea({ title: 'Four' })).status, 201);
  });

  test('keeps emoji, accents and symbols as typed', async () => {
    const idea = await s.makeIdea({ title: 'Rappels par texto — français ✓ 😀', name: 'Zoë Müller' });
    assert.equal(idea.title, 'Rappels par texto — français ✓ 😀');
    assert.equal(idea.author_name, 'Zoë Müller');
  });

  describe('validation failures (nothing is saved)', () => {
    const rejects = (label, overrides, messagePattern) =>
      test(label, async () => {
        const before = (await s.get('/api/ideas')).json.length;
        const res = await s.postIdea(overrides, ipFor(2));
        assert.equal(res.status, 400, res.text);
        assert.match(res.json.error, messagePattern);
        assert.equal((await s.get('/api/ideas')).json.length, before, 'no idea may be created');
      });

    rejects('title too short (3 characters)', { title: 'abc' }, /title/i);
    rejects('title missing', { title: undefined }, /title/i);
    rejects('title only spaces', { title: '      ' }, /title/i);
    rejects('title is a list instead of text', { title: ['a long enough title'] }, /title/i);
    rejects('title is an object instead of text', { title: { x: 'a long enough title' } }, /title/i);
    rejects('name missing', { name: undefined }, /name/i);
    rejects('name only spaces', { name: '   ' }, /name/i);
    rejects('email missing', { email: undefined }, /email/i);
    rejects('category that does not exist', { category_id: 99999 }, /category/i);
    rejects('category that is not a number', { category_id: 'abc' }, /category/i);

    for (const bad of ['', 'plain', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'a@b.', 'a@@b.com', 'a@b@c.com', ' ']) {
      rejects(`email ${JSON.stringify(bad)}`, { email: bad }, /email/i);
    }
  });

  test('accepts ordinary and unusual-but-valid email addresses', async () => {
    for (const email of ['a@b.co', 'first.last+tag@sub.domain.org', 'UPPER@CASE.COM', 'o\'brien@clinic.ca']) {
      assert.equal((await s.postIdea({ title: 'Email check ' + email, email }, ipFor(3))).status, 201, email);
    }
  });
});

describe('similar suggestions — counted and shown to the customer', () => {
  let first;
  before(async () => {
    first = await s.makeIdea({ title: 'Export reports to Excel', description: 'Monthly numbers for finance', email: 'ann@x.ca' }, ipFor(10));
    await s.addVotes(first.id, 3, 'sim');          // 1 (creator) + 3 = 4 votes
  });

  test('a similar idea reports how many people already asked for the original', async () => {
    const res = await s.postIdea({ title: 'Excel export of my reports', email: 'new1@x.ca' }, ipFor(11));
    assert.equal(res.status, 201);
    const { similar } = res.json;
    assert.equal(similar.matches.length, 1);
    assert.equal(similar.matches[0].id, first.id);
    assert.equal(similar.matches[0].vote_count, 4);
    assert.equal(similar.people, 4, 'the number shown to the customer');
  });

  test('the customer\'s own new idea is not counted as similar to itself', async () => {
    const res = await s.postIdea({ title: 'Exporting reports into Excel please', email: 'new2@x.ca' }, ipFor(11));
    assert.ok(!res.json.similar.matches.some((m) => m.id === res.json.idea.id));
  });

  test('the number is the total votes across ALL similar ideas and grows as people vote', async () => {
    const other = await s.makeIdea({ title: 'Reports export to CSV file', email: 'csv@x.ca' }, ipFor(12));
    await s.addVotes(other.id, 1, 'csv');          // 2 votes
    const res = await s.postIdea({ title: 'Export my reports', email: 'new3@x.ca' }, ipFor(13));
    const { matches, people } = res.json.similar;
    assert.ok(matches.length >= 2);
    assert.equal(people, matches.reduce((sum, m) => sum + m.vote_count, 0));
    const ids = matches.map((m) => m.id);
    assert.ok(ids.includes(first.id) && ids.includes(other.id));

    await s.vote(first.id, 'extra-voter@x.ca', 'Extra', ipFor(14));
    const again = await s.postIdea({ title: 'Export my reports now', email: 'new4@x.ca' }, ipFor(13));
    assert.ok(again.json.similar.people > people, 'a new vote must raise the number');
  });

  test('an unrelated idea sees 0 similar', async () => {
    const res = await s.postIdea({ title: 'Google Calendar two-way sync' }, ipFor(15));
    assert.deepEqual(res.json.similar, { matches: [], people: 0 });
  });

  test('shows at most 5 similar ideas', async () => {
    for (let i = 0; i < 7; i++) await s.makeIdea({ title: `Waitlist notification option ${i}`, email: `wl${i}@x.ca` }, ipFor(16 + i));
    const res = await s.postIdea({ title: 'Waitlist notification', email: 'wlnew@x.ca' }, ipFor(30));
    assert.equal(res.json.similar.matches.length, 5);
  });

  test('similar results tell the caller which ones they already voted for', async () => {
    const res = await s.get('/api/similar?' + new URLSearchParams({ title: 'Export reports to Excel', email: 'sim0-' + first.id + '@example.com' }));
    const match = res.json.matches.find((m) => m.id === first.id);
    assert.equal(match.has_voted, true);
    const stranger = await s.get('/api/similar?' + new URLSearchParams({ title: 'Export reports to Excel', email: 'nobody@x.ca' }));
    assert.equal(stranger.json.matches.find((m) => m.id === first.id).has_voted, false);
  });

  test('GET /api/similar: live check while typing', async () => {
    const res = await s.get('/api/similar?title=' + encodeURIComponent('Excel export'), ipFor(31));
    assert.equal(res.status, 200);
    assert.ok(res.json.matches.some((m) => m.id === first.id));
    assert.ok(res.json.people >= 4);
  });

  test('GET /api/similar: empty, missing and filler-only titles give an empty answer, not an error', async () => {
    for (const q of ['', '?title=', '?title=%20%20', '?title=please%20add%20the%20feature', '?title=!!!']) {
      const res = await s.get('/api/similar' + q, ipFor(32));
      assert.equal(res.status, 200, q);
      assert.deepEqual(res.json, { matches: [], people: 0 }, q);
    }
  });

  test('GET /api/similar: huge or oddly-shaped input is handled', async () => {
    const huge = await s.get('/api/similar?title=' + 'export+'.repeat(400), ipFor(33));
    assert.equal(huge.status, 200);
    const array = await s.get('/api/similar?title=a&title=b', ipFor(33));
    assert.equal(array.status, 200);
  });
});

describe('ranking: the most-requested ideas come first (the priority list)', () => {
  test('ideas are ordered by number of votes, highest first', async () => {
    const a = await s.makeIdea({ title: 'Rank test alpha one' }, ipFor(40));
    const b = await s.makeIdea({ title: 'Rank test bravo two' }, ipFor(40));
    const c = await s.makeIdea({ title: 'Rank test charlie three' }, ipFor(40));
    await s.addVotes(a.id, 0, 'r');
    await s.addVotes(b.id, 4, 'r');   // 5 votes
    await s.addVotes(c.id, 2, 'r');   // 3 votes
    const list = (await s.get('/api/ideas?q=Rank+test')).json;
    assert.deepEqual(list.map((i) => i.id), [b.id, c.id, a.id]);
    assert.deepEqual(list.map((i) => i.vote_count), [5, 3, 1]);
  });

  test('a new vote moves an idea up the list', async () => {
    const list = (await s.get('/api/ideas?q=Rank+test')).json;
    const last = list[list.length - 1];
    await s.addVotes(last.id, 6, 'climb');
    const after = (await s.get('/api/ideas?q=Rank+test')).json;
    assert.equal(after[0].id, last.id);
  });

  test('ideas with the same number of votes: the newer one comes first, every time', async () => {
    const x = await s.makeIdea({ title: 'Tie break zebra first' }, ipFor(41));
    const y = await s.makeIdea({ title: 'Tie break zebra second' }, ipFor(41));
    const z = await s.makeIdea({ title: 'Tie break zebra third' }, ipFor(41));
    for (let i = 0; i < 3; i++) {
      const order = (await s.get('/api/ideas?q=Tie+break+zebra')).json.map((i2) => i2.id);
      assert.deepEqual(order, [z.id, y.id, x.id]);
    }
  });

  test('"Newest" sorts by creation order instead of votes', async () => {
    const list = (await s.get('/api/ideas?sort=new')).json;
    const ids = list.map((i) => i.id);
    assert.deepEqual(ids, [...ids].sort((p, q) => q - p));
  });
});

describe('voting', () => {
  let idea;
  before(async () => { idea = await s.makeIdea({ title: 'Voting playground idea' }, ipFor(50)); });

  test('adds a vote, and clicking again removes it', async () => {
    const add = await s.vote(idea.id, 'toggle@x.ca', 'Toggler', ipFor(51));
    assert.equal(add.status, 200);
    assert.deepEqual(add.json, { has_voted: true, vote_count: 2 });
    const remove = await s.vote(idea.id, 'toggle@x.ca', 'Toggler', ipFor(51));
    assert.deepEqual(remove.json, { has_voted: false, vote_count: 1 });
    const again = await s.vote(idea.id, 'toggle@x.ca', 'Toggler', ipFor(51));
    assert.deepEqual(again.json, { has_voted: true, vote_count: 2 });
  });

  test('one person = one vote, even if the email is typed with different capitals or spaces', async () => {
    const before = (await s.get(`/api/ideas/${idea.id}`)).json.vote_count;
    await s.vote(idea.id, 'Case.Test@X.CA', 'Case', ipFor(52));
    const second = await s.vote(idea.id, '  case.test@x.ca ', 'Case', ipFor(52));
    assert.equal(second.json.has_voted, false, 'second click removes the same person\'s vote');
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.vote_count, before);
  });

  test('different people each count', async () => {
    const before = (await s.get(`/api/ideas/${idea.id}`)).json.vote_count;
    await s.vote(idea.id, 'p1@x.ca', 'P1', ipFor(53));
    await s.vote(idea.id, 'p2@x.ca', 'P2', ipFor(53));
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.vote_count, before + 2);
  });

  test('the list and detail know which ideas the visitor already voted for', async () => {
    const mine = (await s.get('/api/ideas?email=p1@x.ca')).json.find((i) => i.id === idea.id);
    assert.equal(mine.has_voted, true);
    const theirs = (await s.get('/api/ideas?email=stranger@x.ca')).json.find((i) => i.id === idea.id);
    assert.equal(theirs.has_voted, false);
    const anon = (await s.get('/api/ideas')).json.find((i) => i.id === idea.id);
    assert.equal(anon.has_voted, false);
    assert.equal((await s.get(`/api/ideas/${idea.id}?email=p1@x.ca`)).json.has_voted, true);
  });

  test('the creator can remove their own vote (the idea stays on the board)', async () => {
    const own = await s.makeIdea({ title: 'Creator vote toggling', email: 'creator@x.ca' }, ipFor(54));
    const res = await s.vote(own.id, 'creator@x.ca', 'Creator', ipFor(54));
    assert.deepEqual(res.json, { has_voted: false, vote_count: 0 });
    assert.ok((await s.get('/api/ideas')).json.some((i) => i.id === own.id));
  });

  describe('validation failures', () => {
    for (const [label, body, pattern] of [
      ['missing name', { email: 'a@b.co' }, /name/i],
      ['blank name', { name: '  ', email: 'a@b.co' }, /name/i],
      ['missing email', { name: 'A' }, /email/i],
      ['invalid email', { name: 'A', email: 'nope' }, /email/i],
    ]) {
      test(label, async () => {
        const res = await s.post(`/api/ideas/${idea.id}/vote`, { ...body, form_token: s.token }, ipFor(55));
        assert.equal(res.status, 400);
        assert.match(res.json.error, pattern);
      });
    }

    for (const id of [999999, 0, -1, 'abc', '1.5', '1e3x']) {
      test(`idea ${JSON.stringify(id)} does not exist`, async () => {
        const res = await s.post(`/api/ideas/${encodeURIComponent(id)}/vote`, { name: 'A', email: 'a@b.co', form_token: s.token }, ipFor(56));
        assert.equal(res.status, 404);
        assert.match(res.json.error, /no longer exists/i);
      });
    }
  });
});

describe('listing, filtering and searching', () => {
  let planned, reportsCat;
  before(async () => {
    const cats = (await s.get('/api/meta')).json.categories;
    reportsCat = cats.find((c) => c.name === 'Scheduling');
    planned = await s.makeIdea({ title: 'Filter target waitlist', description: 'Searchable description zebra', category_id: reportsCat.id }, ipFor(60));
    const admin = await s.admin();
    await admin.patch(`/api/admin/ideas/${planned.id}`, { status: 'planned' });
    await s.makeIdea({ title: '100% uptime alerts', description: 'literal percent sign' }, ipFor(60));
    await s.makeIdea({ title: 'Snake_case names', description: 'literal underscore' }, ipFor(60));
  });

  test('filters by status', async () => {
    const list = (await s.get('/api/ideas?status=planned')).json;
    assert.ok(list.length >= 1 && list.every((i) => i.status === 'planned'));
    assert.ok(list.some((i) => i.id === planned.id));
  });

  test('filters by category', async () => {
    const list = (await s.get(`/api/ideas?category=${reportsCat.id}`)).json;
    assert.ok(list.length >= 1 && list.every((i) => i.category_id === reportsCat.id));
  });

  test('combines filters', async () => {
    const list = (await s.get(`/api/ideas?status=planned&category=${reportsCat.id}&q=waitlist`)).json;
    assert.deepEqual(list.map((i) => i.id), [planned.id]);
  });

  test('search looks in titles and descriptions, ignoring capitals', async () => {
    assert.ok((await s.get('/api/ideas?q=WAITLIST')).json.some((i) => i.id === planned.id));
    assert.ok((await s.get('/api/ideas?q=zebra+description')).json.length === 0, 'both words must appear next to each other');
    assert.ok((await s.get('/api/ideas?q=searchable+description')).json.some((i) => i.id === planned.id));
  });

  test('search treats % and _ as ordinary characters, not wildcards', async () => {
    const percent = (await s.get('/api/ideas?q=' + encodeURIComponent('%'))).json;
    assert.ok(percent.length >= 1 && percent.every((i) => (i.title + i.description).includes('%')), 'only ideas containing a % sign');
    const underscore = (await s.get('/api/ideas?q=' + encodeURIComponent('_'))).json;
    assert.ok(underscore.length >= 1 && underscore.every((i) => (i.title + i.description).includes('_')), 'only ideas containing an underscore');
  });

  test('a filter with no matches gives an empty list, not an error', async () => {
    const res = await s.get('/api/ideas?status=done&q=nothing-matches-this');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, []);
  });

  test('unknown status, bad category and repeated parameters do not break anything', async () => {
    for (const q of ['status=bogus', 'category=abc', 'category=-5', 'status=a&status=b', 'sort=bogus', 'q=%27%3B+DROP+TABLE+ideas%3B--']) {
      const res = await s.get('/api/ideas?' + q);
      assert.equal(res.status, 200, q);
      assert.ok(Array.isArray(res.json), q);
    }
    assert.ok((await s.get('/api/ideas')).json.length > 0, 'data must still be there after the injection attempt');
  });

  test('a single idea can be opened, with its comments', async () => {
    const res = await s.get(`/api/ideas/${planned.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'Filter target waitlist');
    assert.deepEqual(res.json.comments, []);
  });

  test('opening an idea that does not exist gives a clear 404', async () => {
    for (const id of ['999999', 'abc', '-3']) {
      const res = await s.get(`/api/ideas/${id}`);
      assert.equal(res.status, 404, id);
      assert.match(res.json.error, /no longer exists/i);
    }
  });
});

describe('privacy: customers never see anyone\'s email or internal details', () => {
  test('public responses contain no email addresses, IP fingerprints or approval flags', async () => {
    const idea = await s.makeIdea({ title: 'Privacy check idea', email: 'secret.person@private-clinic.ca' }, ipFor(70));
    await s.vote(idea.id, 'secret.voter@private-clinic.ca', 'Voter', ipFor(71));
    await s.comment(idea.id, 'Nice one', { email: 'secret.commenter@private-clinic.ca' }, ipFor(72));
    const bodies = [
      (await s.get('/api/ideas')).text,
      (await s.get(`/api/ideas/${idea.id}`)).text,
      (await s.get('/api/similar?title=Privacy+check+idea')).text,
      JSON.stringify((await s.postIdea({ title: 'Privacy check idea again', email: 'x1@private-clinic.ca' }, ipFor(73))).json),
    ];
    for (const body of bodies) {
      assert.ok(!/private-clinic\.ca/.test(body), 'an email address leaked');
      assert.ok(!/author_email|ip_hash|approved/.test(body), 'an internal field leaked');
    }
  });
});

describe('comments', () => {
  let idea;
  before(async () => { idea = await s.makeIdea({ title: 'Comment target idea' }, ipFor(80)); });

  test('a comment is saved, shown on the idea and counted', async () => {
    const res = await s.comment(idea.id, 'We would use this daily.', { name: 'Luc' }, ipFor(81));
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { ok: true, pending: false });
    const detail = (await s.get(`/api/ideas/${idea.id}`)).json;
    assert.equal(detail.comments.length, 1);
    assert.equal(detail.comments[0].body, 'We would use this daily.');
    assert.equal(detail.comments[0].name, 'Luc');
    assert.equal(detail.comments[0].is_admin, 0);
    assert.equal(detail.comment_count, 1);
    assert.ok(!('email' in detail.comments[0]), 'comment emails stay private');
  });

  test('comments appear oldest first', async () => {
    await s.comment(idea.id, 'Second comment', {}, ipFor(81));
    const bodies = (await s.get(`/api/ideas/${idea.id}`)).json.comments.map((c) => c.body);
    assert.deepEqual(bodies.slice(0, 2), ['We would use this daily.', 'Second comment']);
  });

  test('over-long comments are cut to 1000 characters', async () => {
    await s.comment(idea.id, 'x'.repeat(4000), {}, ipFor(81));
    const comments = (await s.get(`/api/ideas/${idea.id}`)).json.comments;
    assert.equal(comments[comments.length - 1].body.length, 1000);
  });

  test('a customer cannot pretend to be the team by sending is_admin', async () => {
    await s.comment(idea.id, 'Spoofed official reply', { is_admin: 1, approved: 1 }, ipFor(82));
    const spoof = (await s.get(`/api/ideas/${idea.id}`)).json.comments.find((c) => c.body === 'Spoofed official reply');
    assert.equal(spoof.is_admin, 0);
  });

  test('a comment containing a web link is held back from the public (spam)', async () => {
    const before = (await s.get(`/api/ideas/${idea.id}`)).json;
    const res = await s.comment(idea.id, 'Great deals at https://spam.example', {}, ipFor(83));
    assert.equal(res.status, 201);
    assert.equal(res.json.pending, true);
    const after = (await s.get(`/api/ideas/${idea.id}`)).json;
    assert.equal(after.comments.length, before.comments.length);
    assert.equal(after.comment_count, before.comment_count);
  });

  test('a comment whose NAME contains a link is held back too', async () => {
    const res = await s.comment(idea.id, 'Looks fine', { name: 'visit www.spam.example' }, ipFor(83));
    assert.equal(res.json.pending, true);
  });

  describe('validation failures', () => {
    for (const [label, body, pattern] of [
      ['empty comment', { body: '' }, /comment/i],
      ['spaces only', { body: '    ' }, /comment/i],
      ['comment is a list', { body: ['a', 'b'] }, /comment/i],
      ['missing name', { name: '' }, /name/i],
      ['bad email', { email: 'nope' }, /email/i],
    ]) {
      test(label, async () => {
        const res = await s.post(`/api/ideas/${idea.id}/comments`, {
          name: 'A', email: 'a@b.co', body: 'text', form_token: s.token, ...body,
        }, ipFor(84));
        assert.equal(res.status, 400, res.text);
        assert.match(res.json.error, pattern);
      });
    }

    test('commenting on an idea that does not exist', async () => {
      const res = await s.comment(999999, 'hello', {}, ipFor(84));
      assert.equal(res.status, 404);
    });
  });
});

describe('stored text is returned exactly as typed (the page makes it safe to display)', () => {
  test('HTML and script text is kept as plain data, never changed or executed by the server', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const idea = await s.makeIdea({ title: payload, description: payload, name: payload }, ipFor(90));
    const res = await s.get(`/api/ideas/${idea.id}`);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.json.title, payload.slice(0, 120));
    assert.equal(res.json.description, payload);
  });
});
