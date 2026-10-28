// ============================================================================
// app.js — what the CUSTOMER BOARD DOES (the "front end")
// ----------------------------------------------------------------------------
// This code runs in the visitor's web browser. It:
//   • asks the server for the list of ideas and draws them on the page
//   • sends new ideas, votes and comments to the server
//   • checks for similar ideas while someone types
//   • remembers the visitor's name + email so they only type it once
//
// Words you'll see a lot:
//   async/await  → "wait for the server to answer before continuing"
//   fetch()      → the browser's built-in way to talk to the server
//   document.getElementById('x') → grab the HTML element with id="x"
// ============================================================================

// ---------- Small helpers ----------

// Shortcut for finding an element by its id.
const $ = (id) => document.getElementById(id);

// IMPORTANT for safety: turn characters like < and > into harmless text, so
// nobody can sneak code into the page by typing it into an idea.
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Your brand's wording (set in branding/brand.json). The server puts it in the
// page as a small block of data; if that is ever missing we fall back to plain
// defaults so the board still works.
const BRAND = (() => {
  try { return JSON.parse($('brand-data').textContent); }
  catch { return { name: '', text: { emptyList: 'No ideas yet. Be the first!', firstToSuggest: 'You are the first to suggest this.' } }; }
})();

// Talk to our server. Sends JSON, returns JSON, and throws a readable error
// if something went wrong (e.g. "Enter a valid email address").
// Every post, vote and comment also carries the "form token" the server gave
// this page when it loaded — part of the bot protection (see security.js).
async function api(path, options = {}) {
  const body = options.body ? { ...options.body, form_token: meta.form_token } : undefined;
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// "3 days ago" style dates. The server stores times in UTC, hence the "Z".
function timeAgo(sqlDate) {
  const seconds = (Date.now() - new Date(sqlDate.replace(' ', 'T') + 'Z')) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

// A small message that pops up at the bottom for 2.5 seconds.
function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Wait until the user stops typing for `ms` milliseconds before running `fn`
// (so we don't ask the server for similar ideas on every single keystroke).
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ---------- Remembering who the visitor is ----------
// Stored in the browser's localStorage. Wrapped in try/catch because some
// browsers (private mode) block it — the page still works, it just forgets.
const ME_KEY = 'featureBoard.me';
let me = null;
try { me = JSON.parse(localStorage.getItem(ME_KEY)); } catch { me = null; }

function saveMe(name, email) {
  me = { name: name.trim(), email: email.trim().toLowerCase() };
  try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch { /* ignore */ }
  showWhoAmI();
}

function showWhoAmI() {
  const el = $('whoami');
  if (me) {
    el.textContent = `Voting as ${me.name} (change)`;
    el.classList.remove('hidden');
    $('name').value = me.name;
    $('email').value = me.email;
  } else {
    el.classList.add('hidden');
  }
}

// Ask for name + email (if we don't have them yet). Resolves to `me`, or null if they cancel.
function ensureIdentity({ force = false } = {}) {
  if (me && !force) return Promise.resolve(me);
  const dialog = $('who-dialog');
  $('who-name').value = me?.name || '';
  $('who-email').value = me?.email || '';
  $('who-error').classList.add('hidden');
  dialog.showModal();
  return new Promise((resolve) => {
    const form = $('who-form');
    const onSubmit = (e) => {
      e.preventDefault();
      const name = $('who-name').value.trim();
      const email = $('who-email').value.trim();
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        $('who-error').textContent = 'Enter your name and a valid email address.';
        $('who-error').classList.remove('hidden');
        return;
      }
      saveMe(name, email);
      cleanup(); dialog.close(); resolve(me);
    };
    const onClose = () => { cleanup(); resolve(null); };
    function cleanup() { form.removeEventListener('submit', onSubmit); dialog.removeEventListener('close', onClose); }
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

// ---------- Page state ----------
const state = { sort: 'top', status: '', category: '', q: '' };
let meta = { statuses: [], categories: [], form_token: '', turnstile_site_key: '' };
const statusLabel = (key) => meta.statuses.find((s) => s.key === key)?.label || key;

// ---------- Cloudflare "Verify you are human" (only if switched on) ----------
// The server tells us a "site key" if Turnstile is set up. We then load
// Cloudflare's script and place the check inside the idea and comment forms.
// Each check gives a one-time token that we send along with the post.
const turnstileWidgets = {}; // container id -> widget id
let turnstileLoading = null;

function loadTurnstile() {
  if (!meta.turnstile_site_key) return Promise.resolve(false);
  if (!turnstileLoading) {
    turnstileLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return turnstileLoading;
}

async function renderTurnstile(containerId) {
  if (!(await loadTurnstile())) return;
  const el = $(containerId);
  if (!el) return;
  if (turnstileWidgets[containerId] !== undefined) {
    try { window.turnstile.remove(turnstileWidgets[containerId]); } catch { /* already gone */ }
  }
  el.innerHTML = '';
  turnstileWidgets[containerId] = window.turnstile.render(el, { sitekey: meta.turnstile_site_key });
}

function turnstileToken(containerId) {
  const widget = turnstileWidgets[containerId];
  return widget !== undefined && window.turnstile ? window.turnstile.getResponse(widget) || '' : '';
}

// Tokens work only once, so get a fresh check after every attempt.
function resetTurnstile(containerId) {
  const widget = turnstileWidgets[containerId];
  if (widget !== undefined && window.turnstile) window.turnstile.reset(widget);
}

// ---------- Drawing pieces of the page ----------

// The vote button. `small` is the compact version used in lists inside pop-ups.
function voteButton(idea, small = false) {
  return `
    <button class="vote ${small ? 'vote-sm' : ''}" type="button" data-vote="${idea.id}"
            aria-pressed="${idea.has_voted ? 'true' : 'false'}"
            aria-label="${idea.has_voted ? 'Remove your vote' : 'Vote for this idea'} (${idea.vote_count} votes)">
      <svg class="arrow" viewBox="0 0 14 10" aria-hidden="true"><path d="M7 0 14 10H0z" fill="currentColor"/></svg>
      <span class="count">${idea.vote_count}</span>
      ${small ? '' : `<span class="word">${idea.vote_count === 1 ? 'vote' : 'votes'}</span>`}
    </button>`;
}

function statusPill(key) {
  return `<span class="status" style="--dot: var(--s-${esc(key)})">${esc(statusLabel(key))}</span>`;
}

function ideaRow(idea) {
  return `
    <li class="idea">
      ${voteButton(idea)}
      <div class="idea-body">
        <h3 class="idea-title"><button type="button" data-open="${idea.id}">${esc(idea.title)}</button></h3>
        ${idea.description ? `<p class="idea-desc">${esc(idea.description)}</p>` : ''}
        <div class="meta">
          ${statusPill(idea.status)}
          ${idea.category ? `<span class="tag">${esc(idea.category)}</span>` : ''}
          <span>${idea.comment_count} comment${idea.comment_count === 1 ? '' : 's'}</span>
          <span>${timeAgo(idea.created_at)}</span>
        </div>
      </div>
    </li>`;
}

// ---------- Loading data from the server ----------

async function loadMeta() {
  meta = await api('/api/meta');
  // Fill the dropdown menus with the statuses and categories.
  const options = (list, valueKey, labelKey) =>
    list.map((x) => `<option value="${esc(x[valueKey])}">${esc(x[labelKey])}</option>`).join('');
  $('filter-status').insertAdjacentHTML('beforeend', options(meta.statuses, 'key', 'label'));
  $('filter-category').insertAdjacentHTML('beforeend', options(meta.categories, 'id', 'name'));
  $('category').insertAdjacentHTML('beforeend', options(meta.categories, 'id', 'name'));
}

async function loadIdeas() {
  // Build the URL with the current filters, e.g. /api/ideas?sort=top&status=planned
  const params = new URLSearchParams({ ...state, email: me?.email || '' });
  const ideas = await api('/api/ideas?' + params);
  $('ideas').innerHTML = ideas.length
    ? ideas.map(ideaRow).join('')
    : `<li class="empty">${state.q || state.status || state.category
        ? 'No ideas match those filters. Try clearing the search or picking “All”.'
        : esc(BRAND.text.emptyList)}</li>`;
}

// ---------- Voting ----------

async function vote(ideaId) {
  const who = await ensureIdentity();
  if (!who) return; // they closed the pop-up
  try {
    const result = await api(`/api/ideas/${ideaId}/vote`, { method: 'POST', body: who });
    // Update every vote button for this idea on the page (list + any open pop-up).
    document.querySelectorAll(`[data-vote="${ideaId}"]`).forEach((btn) => {
      btn.setAttribute('aria-pressed', String(result.has_voted));
      btn.querySelector('.count').textContent = result.vote_count;
      const word = btn.querySelector('.word');
      if (word) word.textContent = result.vote_count === 1 ? 'vote' : 'votes';
      btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    });
    toast(result.has_voted ? 'Vote added' : 'Vote removed');
    if (state.sort === 'top') loadIdeas(); // re-sort so the ranking stays accurate
  } catch (err) {
    toast(err.message);
  }
}

// ---------- "Already suggested?" while typing ----------

const checkSimilar = debounce(async () => {
  const title = $('title').value.trim();
  if (title.length < 4) return $('similar-hint').classList.add('hidden');
  const { matches } = await api('/api/similar?' + new URLSearchParams({ title, email: me?.email || '' }));
  if (!matches.length) return $('similar-hint').classList.add('hidden');
  $('similar-list').innerHTML = matches.map((i) => `
    <li>
      <button class="btn-link" type="button" data-open="${i.id}">${esc(i.title)}</button>
      ${voteButton(i, true)}
    </li>`).join('');
  $('similar-hint').classList.remove('hidden');
}, 350);

// ---------- Posting a new idea ----------

async function submitIdea(e) {
  e.preventDefault();
  const errorEl = $('suggest-error');
  errorEl.classList.add('hidden');
  const body = {
    title: $('title').value,
    description: $('description').value,
    category_id: $('category').value,
    name: $('name').value,
    email: $('email').value,
    website: $('hp-idea').value,                 // bot trap: real people leave this empty
    turnstile_token: turnstileToken('ts-idea'),  // Cloudflare check (if switched on)
  };
  $('submit-btn').disabled = true;
  try {
    const { idea, pending, similar } = await api('/api/ideas', { method: 'POST', body });
    saveMe(body.name, body.email);
    $('suggest-form').reset();
    showWhoAmI();
    $('more').classList.add('hidden');
    $('similar-hint').classList.add('hidden');
    showResult(idea, similar, pending);
    loadIdeas();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    $('submit-btn').disabled = false;
    resetTurnstile('ts-idea');
  }
}

// The "thank you" pop-up, showing how many people asked for something similar.
// `pending` = the idea is waiting for the team's review before it appears.
function showResult(idea, similar, pending) {
  const n = similar.people;
  $('result-content').innerHTML = `
    <div class="dialog-head">
      <h2 id="result-title">${pending ? 'Thanks, We\'ve Got Your Idea' : 'Your Idea Is Posted'}</h2>
      <button class="close" type="button" data-close aria-label="Close">×</button>
    </div>
    <p><strong>${esc(idea.title)}</strong> ${pending
      ? 'will appear on the board, with your vote, once our team has reviewed it.'
      : 'is now on the board with your vote.'}</p>
    ${n > 0 ? `
      <p class="result-count">${n}</p>
      <p>${n === 1 ? 'other person has' : 'other people have'} asked for something similar.
         If one of these is what you meant, vote for it too so it counts.</p>
      <ul class="comments">
        ${similar.matches.map((i) => `
          <li class="comment" style="display:flex;justify-content:space-between;gap:12px;align-items:center">
            <span><button class="btn-link" type="button" data-open="${i.id}">${esc(i.title)}</button><br>
            <span class="muted small">${statusPill(i.status)}</span></span>
            ${voteButton(i, true)}
          </li>`).join('')}
      </ul>` : `
      <p class="muted">${esc(BRAND.text.firstToSuggest)}</p>`}
    <button class="btn btn-primary" type="button" data-close>Done</button>`;
  $('result-dialog').showModal();
}

// ---------- One idea in detail, with comments ----------

async function openIdea(id) {
  let idea;
  try {
    idea = await api(`/api/ideas/${id}?` + new URLSearchParams({ email: me?.email || '' }));
  } catch (err) { return toast(err.message); }

  $('detail-content').innerHTML = `
    <div class="dialog-head">
      <div class="detail-top">
        ${voteButton(idea)}
        <div>
          <h2 id="detail-title">${esc(idea.title)}</h2>
          <div class="meta">
            ${statusPill(idea.status)}
            ${idea.category ? `<span class="tag">${esc(idea.category)}</span>` : ''}
            <span>Suggested by ${esc(idea.author_name)}, ${timeAgo(idea.created_at)}</span>
          </div>
        </div>
      </div>
      <button class="close" type="button" data-close aria-label="Close">×</button>
    </div>
    ${idea.description ? `<p class="detail-desc">${esc(idea.description)}</p>` : ''}
    <h3 style="font-size:18px;margin-top:20px">Comments</h3>
    <ul class="comments">
      ${idea.comments.length ? idea.comments.map((c) => `
        <li class="comment ${c.is_admin ? 'team' : ''}">
          <span class="comment-name">${esc(c.name)}</span>${c.is_admin ? '<span class="badge">Official reply</span>' : ''}
          <span class="muted small"> ${timeAgo(c.created_at)}</span>
          <p>${esc(c.body)}</p>
        </li>`).join('') : '<li class="muted">No comments yet.</li>'}
    </ul>
    <form id="comment-form" novalidate>
      <label for="comment-body">Add a comment</label>
      <textarea id="comment-body" maxlength="1000" placeholder="How would you use this?"></textarea>
      <div class="hp" aria-hidden="true">
        <label for="hp-comment">Website</label>
        <input id="hp-comment" type="text" tabindex="-1" autocomplete="off">
      </div>
      <div class="turnstile" id="ts-comment" style="margin-top:10px"></div>
      <p class="error hidden" id="comment-error" role="alert"></p>
      <button class="btn btn-primary" type="submit" style="margin-top:10px">Post Comment</button>
    </form>`;

  $('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('comment-body').value.trim();
    if (!text) return;
    const who = await ensureIdentity();
    if (!who) return;
    try {
      const { pending } = await api(`/api/ideas/${id}/comments`, { method: 'POST', body: {
        ...who, body: text,
        website: $('hp-comment').value,                  // bot trap
        turnstile_token: turnstileToken('ts-comment'),   // Cloudflare check (if on)
      } });
      toast(pending ? 'Thanks! Your comment will appear once our team has reviewed it.' : 'Comment posted');
      openIdea(id);   // redraw with the new comment
      loadIdeas();    // update the comment count in the list
    } catch (err) {
      $('comment-error').textContent = err.message;
      $('comment-error').classList.remove('hidden');
      resetTurnstile('ts-comment');
    }
  });

  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  renderTurnstile('ts-comment');
}

// ---------- Wiring up clicks and typing ----------
// Instead of attaching a click handler to every button, we listen once on the
// whole page and check what was clicked ("event delegation").
document.addEventListener('click', (e) => {
  const voteBtn = e.target.closest('[data-vote]');
  if (voteBtn) return vote(Number(voteBtn.dataset.vote));

  const openBtn = e.target.closest('[data-open]');
  if (openBtn) {
    $('result-dialog').close();
    return openIdea(Number(openBtn.dataset.open));
  }

  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();

  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    state.sort = sortBtn.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === sortBtn)));
    loadIdeas();
  }
});

// Clicking the dark area outside a pop-up closes it.
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

$('title').addEventListener('input', () => {
  const wasHidden = $('more').classList.contains('hidden');
  $('more').classList.toggle('hidden', $('title').value.trim() === '' && !$('description').value);
  // Show the Cloudflare check the first time the full form opens.
  if (wasHidden && !$('more').classList.contains('hidden') && turnstileWidgets['ts-idea'] === undefined) {
    renderTurnstile('ts-idea');
  }
  checkSimilar();
});
$('suggest-form').addEventListener('submit', submitIdea);
$('filter-status').addEventListener('change', (e) => { state.status = e.target.value; loadIdeas(); });
$('filter-category').addEventListener('change', (e) => { state.category = e.target.value; loadIdeas(); });
$('search').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); loadIdeas(); }, 300));
$('whoami').addEventListener('click', () => ensureIdentity({ force: true }).then(() => loadIdeas()));

// ---------- Start! ----------
(async function start() {
  showWhoAmI();
  try {
    await loadMeta();
    await loadIdeas();
  } catch (err) {
    $('ideas').innerHTML = `<li class="empty">Couldn't load ideas: ${esc(err.message)} Refresh the page to try again.</li>`;
  }
})();
