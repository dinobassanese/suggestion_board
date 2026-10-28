// ============================================================================
// similarity.js — finding SIMILAR suggestions
// ----------------------------------------------------------------------------
// When a customer types an idea like "Export reports to Excel", we want to
// spot existing ideas such as "Excel export for reporting" so they can vote
// on that instead of creating a duplicate, and so we can tell them how many
// people have asked for something similar.
//
// How it works (no AI, just word matching):
//   1. Break each text into important words ("keywords"), ignoring filler
//      words like "the", "a", "please", "add".
//   2. Trim word endings so "reports", "reporting" and "report" all match.
//   3. Score how much two ideas' keywords overlap (0 = nothing, 1 = identical).
//   4. Anything above a threshold counts as "similar".
// ============================================================================

// Common words that don't tell us what the feature actually is.
const STOP_WORDS = new Set(`
  a an the and or but if then so to of in on at by for with from into onto
  is are was were be been being it its this that these those there here
  i me my we our you your they them their he she his her
  can could would should will shall may might must do does did
  please add allow allows let lets need needs want wants like would able
  feature features option options ability support new more better way ways
  have has had get gets make makes use using also just really very
`.split(/\s+/).filter(Boolean));

// Very small "stemmer": strips common English endings so word forms match.
function stem(word) {
  return word
    .replace(/(ings|ing)$/, '')
    .replace(/(ations|ation)$/, 'at')
    .replace(/(ies)$/, 'y')
    .replace(/(es|s)$/, '')
    .replace(/(ed)$/, '');
}

// Turn a sentence into a Set (a list with no repeats) of keywords.
function keywords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')        // drop punctuation
      .split(/\s+/)                        // split into words
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
      .map(stem)
      .filter((w) => w.length > 1)
  );
}

// Score the overlap between two keyword sets.
// We divide by the SMALLER set, so a short title like "dark mode" still
// matches a longer one like "Add a dark mode theme for night use".
function overlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Find ideas similar to the given text.
 * @param {string} title        what the customer typed as the title
 * @param {string} description  optional extra detail
 * @param {Array}  ideas        existing ideas, each with {id, title, description}
 * @returns ideas with a "score", best matches first
 */
function findSimilar(title, description, ideas, { threshold = 0.5, limit = 5 } = {}) {
  const titleWords = keywords(title);
  const allWords = keywords(`${title} ${description || ''}`);
  if (titleWords.size === 0) return [];

  return ideas
    .map((idea) => {
      // Use pre-computed keywords when available (see prepareIdea below) — much
      // faster than re-reading every idea's text on every keystroke.
      const ideaTitleWords = idea.titleWords || keywords(idea.title);
      const ideaAllWords = idea.allWords || keywords(`${idea.title} ${idea.description}`);
      // Title-to-title matching counts most; full-text matching is a backup.
      const titleScore = overlapScore(titleWords, ideaTitleWords);
      const fullScore = overlapScore(allWords, ideaAllWords);
      // Tie-break: when two ideas overlap equally, the one whose wording is closest overall wins.
      let shared = 0;
      for (const w of titleWords) if (ideaTitleWords.has(w)) shared++;
      const union = titleWords.size + ideaTitleWords.size - shared;
      const closeness = union ? shared / union : 0;
      return { ...idea, score: Math.max(titleScore, fullScore * 0.8), closeness };
    })
    .filter((idea) => idea.score >= threshold)
    .sort((a, b) => b.score - a.score || b.closeness - a.closeness)
    .slice(0, limit);
}

// Work out an idea's keywords once, so they can be stored and reused.
function prepareIdea(idea) {
  return {
    id: idea.id,
    titleWords: keywords(idea.title),
    allWords: keywords(`${idea.title} ${idea.description}`),
  };
}

module.exports = { findSimilar, keywords, prepareIdea };
