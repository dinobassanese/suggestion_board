// ============================================================================
// tests/similarity.test.js — the "similar suggestions" matcher (similarity.js)
// ----------------------------------------------------------------------------
// This is pure logic with no server or database, so these tests are instant.
// The matcher is what lets the app tell a customer "N people asked for
// something similar", so we test matches, non-matches and awkward inputs.
// ============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keywords, findSimilar, prepareIdea } = require('../similarity');

const idea = (id, title, description = '') => ({ id, title, description });
const ids = (results) => results.map((r) => r.id);

describe('keywords()', () => {
  test('drops filler words and punctuation, lower-cases everything', () => {
    assert.deepEqual([...keywords('Please ADD the Dark-Mode option!')].sort(), ['dark', 'mode']);
  });

  test('treats singular, plural and -ing forms as the same word', () => {
    assert.deepEqual([...keywords('report')], [...keywords('reports')]);
    assert.deepEqual([...keywords('report')], [...keywords('reporting')]);
    assert.deepEqual([...keywords('notification')], [...keywords('notifications')]);
  });

  test('handles empty, missing and non-text input without crashing', () => {
    assert.equal(keywords('').size, 0);
    assert.equal(keywords(null).size, 0);
    assert.equal(keywords(undefined).size, 0);
    assert.equal(keywords('!!! ??? ...').size, 0);
  });

  test('a title made only of filler words has no keywords', () => {
    assert.equal(keywords('Please add the new feature').size, 0);
  });

  test('keeps numbers and ignores single letters', () => {
    const words = keywords('2FA a login');
    assert.ok(words.has('2fa'));
    assert.ok(!words.has('a'));
  });
});

describe('findSimilar()', () => {
  const existing = [
    idea(1, 'Export reports to Excel', 'Monthly numbers for finance'),
    idea(2, 'Dark mode', 'Easier on the eyes'),
    idea(3, 'Slack notifications when a ticket is assigned'),
    idea(4, 'Offline mode on the iPhone app'),
  ];

  test('matches the same idea worded differently (word order, plural, -ing)', () => {
    assert.deepEqual(ids(findSimilar('Excel export for reporting', '', existing)), [1]);
    assert.deepEqual(ids(findSimilar('Exporting my reports into excel', '', existing)), [1]);
  });

  test('matches a short title against a longer existing title', () => {
    assert.deepEqual(ids(findSimilar('Slack notification', '', existing)), [3]);
  });

  test('does not match unrelated ideas', () => {
    assert.deepEqual(findSimilar('Calendar sync with Google', '', existing), []);
    assert.deepEqual(findSimilar('Two-factor login', '', existing), []);
  });

  test('returns nothing when the new title has no meaningful words', () => {
    assert.deepEqual(findSimilar('Please add the new feature', '', existing), []);
    assert.deepEqual(findSimilar('', '', existing), []);
  });

  test('returns nothing when there are no existing ideas', () => {
    assert.deepEqual(findSimilar('Dark mode', '', []), []);
  });

  test('the description can help to find a match', () => {
    const found = findSimilar('Finance numbers', 'export my monthly reports to excel', existing);
    assert.ok(ids(found).includes(1));
  });

  test('puts the best match first and respects the limit', () => {
    const many = [
      idea(10, 'Export reports'),
      idea(11, 'Export reports to Excel and CSV files'),
      idea(12, 'Export'),
      idea(13, 'Export reports to Excel'),
    ];
    const found = findSimilar('Export reports to Excel', '', many, { limit: 2 });
    assert.equal(found.length, 2);
    assert.ok(found[0].score >= found[1].score);
    assert.equal(found[0].id, 13); // identical wording scores highest
  });

  test('a stricter threshold removes weaker matches', () => {
    const partial = [idea(20, 'Export reports to CSV file')];
    assert.equal(findSimilar('Export reports to Excel', '', partial, { threshold: 0.5 }).length, 1);
    assert.equal(findSimilar('Export reports to Excel', '', partial, { threshold: 0.9 }).length, 0);
  });

  test('works with keywords prepared in advance (the speed-up used by the server)', () => {
    const prepared = existing.map((i) => ({ ...i, ...prepareIdea(i) }));
    assert.deepEqual(ids(findSimilar('Excel export for reporting', '', prepared)), [1]);
  });

  test('does not change the ideas it was given', () => {
    const copy = JSON.parse(JSON.stringify(existing));
    findSimilar('Dark mode', '', existing);
    assert.deepEqual(existing, copy);
  });

  test('KNOWN LIMITATION: matches words, not meanings, so synonyms are not matched', () => {
    // The README says so too. This is what the dashboard "Merge" button is for.
    assert.deepEqual(findSimilar('Night theme', '', existing), []);
  });
});
