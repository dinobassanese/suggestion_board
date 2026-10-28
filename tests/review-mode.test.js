// ============================================================================
// tests/review-mode.test.js — "review before publishing" (anti-spam moderation)
// ============================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s, a;
before(async () => { s = await startServer(); a = await s.admin(); }); // review is ON by default
after(async () => { await s.stop(); s.cleanup(); });
const ip = (n) => ({ ip: `10.40.${n}.1` });
const publicIds = async () => (await s.get('/api/ideas')).json.map((i) => i.id);

describe('with review switched on (the default)', () => {
  test('a new idea is accepted but NOT public; the customer is told it is waiting', async () => {
    const res = await s.postIdea({ title: 'Held for review idea' }, ip(1));
    assert.equal(res.status, 201);
    assert.equal(res.json.pending, true);
    assert.ok(!(await publicIds()).includes(res.json.idea.id));
    assert.equal((await s.get(`/api/ideas/${res.json.idea.id}`)).status, 404);
    assert.equal((await s.vote(res.json.idea.id, 'x@example.com', 'X', ip(2))).status, 404, 'cannot vote on unpublished ideas');
    assert.equal((await s.comment(res.json.idea.id, 'hi', {}, ip(2))).status, 404);
  });

  test('pending ideas appear in the staff queue and not in the public stats', async () => {
    const before = (await a.get('/api/admin/stats')).json.totals;
    const idea = await s.makeIdea({ title: 'Queue visible idea' }, ip(3));
    const pending = (await a.get('/api/admin/pending')).json;
    assert.ok(pending.ideas.some((i) => i.id === idea.id && i.author_email === 'person@example.com'));
    const after = (await a.get('/api/admin/stats')).json.totals;
    assert.equal(after.ideas, before.ideas);
    assert.equal(after.votes, before.votes);
    assert.equal(after.pending, before.pending + 1);
    assert.ok(!(await a.get('/api/admin/ideas')).json.some((i) => i.id === idea.id));
  });

  test('pending ideas are NOT counted as "similar" for other customers', async () => {
    await s.makeIdea({ title: 'Unique zebra quantum feature' }, ip(4));
    const sim = (await s.get('/api/similar?title=zebra+quantum+feature', ip(5))).json;
    assert.deepEqual(sim, { matches: [], people: 0 });
  });

  test('approving publishes it, and it then counts as similar', async () => {
    const idea = await s.makeIdea({ title: 'Approve me zebra giraffe feature' }, ip(6));
    assert.equal((await a.post(`/api/admin/ideas/${idea.id}/approve`)).status, 200);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).status, 200);
    const sim = (await s.get('/api/similar?title=zebra+giraffe+feature', ip(7))).json;
    assert.ok(sim.matches.some((m) => m.id === idea.id));
    assert.ok(sim.people >= 1);
  });

  test('rejecting (deleting) a pending idea removes it for good', async () => {
    const idea = await s.makeIdea({ title: 'Reject me idea' }, ip(8));
    assert.equal((await a.del(`/api/admin/ideas/${idea.id}`)).status, 200);
    assert.ok(!(await a.get('/api/admin/pending')).json.ideas.some((i) => i.id === idea.id));
  });

  test('approving something that does not exist is a 404, not a silent success', async () => {
    assert.equal((await a.post('/api/admin/ideas/999999/approve')).status, 404);
    assert.equal((await a.post('/api/admin/comments/999999/approve')).status, 404);
  });

  test('cannot merge into an idea that is not published yet', async () => {
    const pendingIdea = await s.makeIdea({ title: 'Pending merge target' }, ip(9));
    await s.setApproval(false);
    const live = await s.makeIdea({ title: 'Live merge source' }, ip(10));
    await s.setApproval(true);
    assert.equal((await a.post(`/api/admin/ideas/${live.id}/merge`, { into_id: pendingIdea.id })).status, 400);
    assert.equal((await s.get(`/api/ideas/${live.id}`)).status, 200);
  });

  test('comments wait for review too, then show after approval', async () => {
    await s.setApproval(false);
    const idea = await s.makeIdea({ title: 'Commented idea here' }, ip(11));
    await s.setApproval(true);
    const res = await s.comment(idea.id, 'Needs review first', {}, ip(12));
    assert.equal(res.json.pending, true);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.comments.length, 0);
    const pending = (await a.get('/api/admin/pending')).json.comments.find((c) => c.body === 'Needs review first');
    assert.ok(pending);
    await a.post(`/api/admin/comments/${pending.id}/approve`);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.comments.length, 1);
  });
});

describe('with review switched off', () => {
  before(() => s.setApproval(false));
  after(() => s.setApproval(true));

  test('clean ideas go live immediately', async () => {
    const res = await s.postIdea({ title: 'Goes live at once' }, ip(20));
    assert.equal(res.json.pending, false);
    assert.ok((await publicIds()).includes(res.json.idea.id));
  });

  test('ideas containing links are STILL held (spam protection)', async () => {
    for (const [i, overrides] of [
      { title: 'Buy cheap pills https://spam.example' },
      { title: 'Normal title here', description: 'visit www.spam.com today' },
      { title: 'Another normal title', name: 'spam.xyz' },
    ].entries()) {
      const res = await s.postIdea(overrides, ip(21 + i));
      assert.equal(res.status, 201);
      assert.equal(res.json.pending, true, JSON.stringify(overrides));
    }
    const pending = (await a.get('/api/admin/pending')).json.ideas.filter((i) => i.has_link);
    assert.ok(pending.length >= 3);
  });

  test('comments with links are STILL held', async () => {
    const idea = await s.makeIdea({ title: 'Link comment target' }, ip(25));
    assert.equal((await s.comment(idea.id, 'see http://spam.example', {}, ip(26))).json.pending, true);
    assert.equal((await s.get(`/api/ideas/${idea.id}`)).json.comments.length, 0);
  });
});

describe('the review setting', () => {
  test('can be switched with a real true/false and survives a server restart', async () => {
    await s.setApproval(false);
    assert.equal((await a.get('/api/admin/settings')).json.require_approval, false);
    await s.restart();
    a = await s.admin();
    assert.equal((await a.get('/api/admin/settings')).json.require_approval, false);
    await s.setApproval(true);
  });

  test('ignores values that are not true/false', async () => {
    await s.setApproval(true);
    await a.patch('/api/admin/settings', { require_approval: 'false' });
    await a.patch('/api/admin/settings', { require_approval: 0 });
    await a.patch('/api/admin/settings', {});
    assert.equal((await a.get('/api/admin/settings')).json.require_approval, true);
  });
});
