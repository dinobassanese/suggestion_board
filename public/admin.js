// ============================================================================
// admin.js — what the STAFF DASHBOARD DOES
// ----------------------------------------------------------------------------
//   • log in / log out
//   • show overview numbers (ideas, votes, customers, this week's activity)
//   • list every suggestion ranked by votes (your priority list)
//   • change status / category, reply officially, merge duplicates, delete
//   • see who voted (names + emails) and download them as a spreadsheet
//   • add, rename and remove categories
// It reuses the same ideas as app.js: fetch() to talk to the server, and
// esc() to keep typed-in text safe on the page.
// ============================================================================

const $ = (id) => document.getElementById(id);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Please log in.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

// Show dates like "Oct 7, 2026".
function niceDate(sqlDate) {
  return new Date(sqlDate.replace(' ', 'T') + 'Z')
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---------- State ----------
let meta = { statuses: [], categories: [] };
let ideas = [];
let currentIdeaId = null; // the suggestion open in the pop-up
const view = { status: '', q: '', sort: 'vote_count' };

// Build <option> tags for a dropdown, marking the current one as selected.
function statusOptions(selected) {
  return meta.statuses.map((s) =>
    `<option value="${s.key}" ${s.key === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
}
function categoryOptions(selected) {
  return `<option value="">Uncategorized</option>` + meta.categories.map((c) =>
    `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

// ---------- Login ----------
function showLogin() {
  $('dashboard').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  $('password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    $('login-error').classList.add('hidden');
    startDashboard();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// ---------- Overview ----------
function barList(items) {
  // Each bar's width = its value compared to the biggest value in the list.
  const max = Math.max(1, ...items.map((i) => i.value));
  return items.map((i) => `
    <li title="${esc(i.label)}: ${i.value}">
      <span>${i.dot ? `<span class="status" style="--dot: var(--s-${i.dot})">${esc(i.label)}</span>` : esc(i.label)}</span>
      <span class="track"><span class="fill" style="width:${(i.value / max) * 100}%"></span></span>
      <span class="val">${i.value}</span>
    </li>`).join('') || '<li class="muted">Nothing yet</li>';
}

async function loadStats() {
  const { totals, byStatus, byCategory } = await api('/api/admin/stats');
  const tile = (num, label, sub = '') =>
    `<div class="stat"><div class="num">${num}</div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('stats').innerHTML =
    tile(totals.ideas, 'Suggestions', `${totals.ideas_this_week} new this week`) +
    tile(totals.votes, 'Votes', `${totals.votes_this_week} this week`) +
    tile(totals.people, 'Customers taking part') +
    tile(totals.comments, 'Customer comments') +
    tile(totals.pending, 'Waiting for review');
  $('by-status').innerHTML = barList(byStatus.map((s) => ({ label: s.label, value: s.count, dot: s.key })));
  $('by-category').innerHTML = barList(byCategory.map((c) => ({ label: c.name, value: c.votes })));
}

// ---------- Suggestions table ----------
async function loadIdeas() {
  ideas = await api('/api/admin/ideas');
  renderRows();
}

function renderRows() {
  const q = view.q.toLowerCase();
  const shown = ideas
    .filter((i) => !view.status || i.status === view.status)
    .filter((i) => !q || `${i.title} ${i.description} ${i.author_name} ${i.author_email}`.toLowerCase().includes(q))
    .sort((a, b) => view.sort === 'created_at'
      ? b.created_at.localeCompare(a.created_at)
      : b[view.sort] - a[view.sort]);

  $('rows').innerHTML = shown.length ? shown.map((i, n) => `
    <tr>
      <td class="muted">${n + 1}</td>
      <td class="num">
        <span class="votes">${i.vote_count}</span>
        ${i.votes_this_week ? `<div class="trend" title="Votes in the last 7 days">+${i.votes_this_week} this week</div>` : ''}
      </td>
      <td>
        <button class="btn-link" type="button" data-open="${i.id}" style="text-align:left">${esc(i.title)}</button>
        <div class="muted small">${esc(i.author_name)}${i.author_email ? ` &lt;${esc(i.author_email)}&gt;` : ' (no email)'}</div>
      </td>
      <td><select data-field="category_id" data-id="${i.id}" aria-label="Category">${categoryOptions(i.category_id)}</select></td>
      <td><select data-field="status" data-id="${i.id}" aria-label="Status">${statusOptions(i.status)}</select></td>
      <td class="num">${i.comment_count}</td>
      <td class="muted small" style="white-space:nowrap">${niceDate(i.created_at)}</td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="empty">${ideas.length ? 'No suggestions match these filters.' : 'No suggestions yet. Share your board link with customers, or click Add a Request to log one yourself.'}</td></tr>`;
}

// Changing a dropdown in the table saves immediately.
$('rows').addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-field]');
  if (!select) return;
  try {
    await api(`/api/admin/ideas/${select.dataset.id}`, {
      method: 'PATCH', body: { [select.dataset.field]: select.value },
    });
    toast('Saved');
    refresh();
  } catch (err) { toast(err.message); }
});

// ---------- One suggestion in detail ----------
async function openIdea(id) {
  currentIdeaId = id; // remember which one is open (used after deleting a comment)
  const idea = await api(`/api/admin/ideas/${id}`);
  const others = ideas.filter((i) => i.id !== idea.id);

  $('idea-content').innerHTML = `
    <div class="dialog-head">
      <h2 id="edit-title">Manage Suggestion</h2>
      <button class="close" type="button" data-close aria-label="Close">×</button>
    </div>

    <form id="edit-form">
      <div class="field"><label for="e-title">Title</label>
        <input id="e-title" type="text" maxlength="120" value="${esc(idea.title)}"></div>
      <div class="field"><label for="e-desc">Details</label>
        <textarea id="e-desc" maxlength="2000">${esc(idea.description)}</textarea></div>
      <div class="row-2">
        <div class="field"><label for="e-status">Status</label><select id="e-status">${statusOptions(idea.status)}</select></div>
        <div class="field"><label for="e-cat">Category</label><select id="e-cat">${categoryOptions(idea.category_id)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="e-date">Date submitted</label>
          <input id="e-date" type="date" min="2000-01-01" max="${new Date().toISOString().slice(0, 10)}" value="${esc(idea.created_at.slice(0, 10))}"></div>
        <div class="field"><label for="e-extra">Extra votes (added by the team)</label>
          <input id="e-extra" type="number" step="1" min="-10000" max="100000" value="${idea.vote_adjustment}"></div>
      </div>
      <p class="muted small" style="margin-top:-8px">Customers see <strong>${idea.vote_count}</strong> ${idea.vote_count === 1 ? 'vote' : 'votes'}: ${idea.real_votes} real ${idea.real_votes === 1 ? 'voter' : 'voters'} plus ${idea.vote_adjustment} extra. Use extra votes for requests you collected offline or moved over from another tool, and a negative number to lower the total. The date controls the "time ago" shown on the board.</p>
      <p class="muted small">Suggested by ${esc(idea.author_name)}${idea.author_email ? ` (${esc(idea.author_email)})` : ' (no email given)'} on ${niceDate(idea.created_at)}</p>
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </form>

    <div class="section-head" style="margin-top:24px">
      <h3>${idea.voters.length} ${idea.voters.length === 1 ? 'voter' : 'voters'}</h3>
      <a class="btn-link small" href="/api/admin/ideas/${idea.id}/voters.csv">Download Voter Emails</a>
    </div>
    <p class="muted small" style="margin:0 0 8px">"Same network" means votes sent from the same internet connection. A few is normal for coworkers in one office; many on one idea can mean someone voting under several email addresses.</p>
    <div class="voters">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Voted</th><th>Same network as</th><th></th></tr></thead>
        <tbody>${idea.voters.map((v) => `
          <tr>
            <td>${esc(v.name)}</td>
            <td>${v.email ? `<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : '<span class="muted">No email</span>'}</td>
            <td class="muted">${niceDate(v.created_at)}</td>
            <td>${v.same_network
              ? `${v.same_network} other${v.same_network === 1 ? '' : 's'}${v.same_network >= 3 ? '<span class="flag" title="Many votes from one network can mean one person using several emails">Check</span>' : ''}`
              : '<span class="muted">None</span>'}</td>
            <td><button class="btn-link small" type="button" data-del-vote="${v.id}" style="color:var(--danger)">Remove Vote</button></td>
          </tr>`).join('')
          || '<tr><td colspan="5" class="muted">No votes yet.</td></tr>'}</tbody>
      </table>
    </div>

    <h3 style="margin-top:24px">Comments</h3>
    <ul class="comments">
      ${idea.comments.map((c) => `
        <li class="comment ${c.is_admin ? 'team' : ''}">
          <span class="comment-name">${esc(c.name)}</span>${c.is_admin ? '<span class="badge">Official reply</span>' : ''}${c.approved ? '' : '<span class="flag">Waiting for review</span>'}
          <span class="muted small"> ${c.email ? esc(c.email) + ', ' : ''}${niceDate(c.created_at)}</span>
          <button class="btn-link small btn-danger" type="button" data-del-comment="${c.id}" style="float:right;color:var(--danger)">Delete</button>
          <p>${esc(c.body)}</p>
        </li>`).join('') || '<li class="muted">No comments yet.</li>'}
    </ul>
    <form id="reply-form">
      <label for="reply">Post an official reply</label>
      <textarea id="reply" maxlength="1000" placeholder="Customers see this on the public board, marked as an official reply."></textarea>
      <button class="btn" type="submit" style="margin-top:10px">Post Reply</button>
    </form>

    <div class="danger-zone">
      <div class="field">
        <label for="merge-into">Merge this duplicate into</label>
        <select id="merge-into">
          <option value="">Choose the suggestion to keep</option>
          ${others.map((o) => `<option value="${o.id}">${esc(o.title)} (${o.vote_count} votes)</option>`).join('')}
        </select>
      </div>
      <button class="btn" type="button" id="merge-btn">Merge</button>
      <button class="btn btn-danger" type="button" id="delete-btn">Delete Suggestion</button>
    </div>`;

  // Save edits
  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/ideas/${idea.id}`, { method: 'PATCH', body: {
        title: $('e-title').value, description: $('e-desc').value,
        status: $('e-status').value, category_id: $('e-cat').value,
        created_date: $('e-date').value, vote_adjustment: $('e-extra').value === '' ? 0 : $('e-extra').value,
      } });
      toast('Saved'); refresh(); openIdea(idea.id);
    } catch (err) { toast(err.message); }
  });

  // Official reply
  $('reply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('reply').value.trim()) return;
    try {
      await api(`/api/admin/ideas/${idea.id}/comments`, { method: 'POST', body: { body: $('reply').value } });
      toast('Reply posted'); openIdea(idea.id); refresh();
    } catch (err) { toast(err.message); }
  });

  // Merge
  $('merge-btn').addEventListener('click', async () => {
    const into = $('merge-into').value;
    if (!into) return toast('Choose which suggestion to keep first.');
    const target = ideas.find((i) => i.id === Number(into));
    if (!confirm(`Merge into “${target.title}”? Voters and comments move over and this suggestion is removed.`)) return;
    try {
      await api(`/api/admin/ideas/${idea.id}/merge`, { method: 'POST', body: { into_id: Number(into) } });
      toast('Merged'); await refresh(); openIdea(Number(into));
    } catch (err) { toast(err.message); }
  });

  // Delete
  $('delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this suggestion with all its votes and comments? This can’t be undone.')) return;
    await api(`/api/admin/ideas/${idea.id}`, { method: 'DELETE' });
    $('idea-dialog').close(); toast('Deleted'); refresh();
  });

  if (!$('idea-dialog').open) $('idea-dialog').showModal();
}

// Remove a single vote (delegated: the buttons are created dynamically).
$('idea-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-vote]');
  if (!btn || !confirm('Remove this vote?')) return;
  await api(`/api/admin/votes/${btn.dataset.delVote}`, { method: 'DELETE' });
  toast('Vote removed');
  await refresh();
  openIdea(currentIdeaId);
});

// Delete a comment (delegated: the buttons are created dynamically).
$('idea-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-comment]');
  if (!btn || !confirm('Delete this comment?')) return;
  await api(`/api/admin/comments/${btn.dataset.delComment}`, { method: 'DELETE' });
  toast('Comment deleted');
  await refresh();
  openIdea(currentIdeaId);
});

// ---------- Add a request on a customer's behalf ----------
$('add-open').addEventListener('click', () => {
  $('add-form').reset();
  $('add-error').classList.add('hidden');
  $('add-date').max = new Date().toISOString().slice(0, 10);
  $('add-cat').innerHTML = categoryOptions('');
  $('add-status').innerHTML = statusOptions('under_review');
  $('add-dialog').showModal();
  $('add-title-input').focus();
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('add-error').classList.add('hidden');
  $('add-submit').disabled = true;
  try {
    const result = await api('/api/admin/ideas', { method: 'POST', body: {
      title: $('add-title-input').value,
      description: $('add-desc').value,
      category_id: $('add-cat').value || null,
      status: $('add-status').value,
      name: $('add-name').value,
      email: $('add-email').value,
      created_date: $('add-date').value,
      vote_adjustment: $('add-extra').value,
    } });
    $('add-dialog').close();
    const n = result.similar.matches.length;
    toast(n
      ? `Added. ${n} similar ${n === 1 ? 'idea already exists' : 'ideas already exist'}: open this one to merge if it's a duplicate.`
      : 'Request added');
    await refresh();
  } catch (err) {
    $('add-error').textContent = err.message;
    $('add-error').classList.remove('hidden');
  }
  $('add-submit').disabled = false;
});

// ---------- Waiting for review ----------
// New ideas and comments that aren't on the public board yet.
async function loadReview() {
  const [{ ideas: pendingIdeas, comments: pendingComments }, settings] =
    await Promise.all([api('/api/admin/pending'), api('/api/admin/settings')]);
  $('require-approval').checked = settings.require_approval;
  $('digest-status').textContent = settings.digest_enabled
    ? `On. One email a day at ${settings.digest_hour}:00 (${settings.digest_timezone}) to ${settings.digest_to}, only when something is new.`
    : 'Off. Add the email settings (see the README) to get one summary email a day.';

  const linkFlag = (item) => item.has_link
    ? '<span class="flag" title="Spam usually contains links">Contains a link</span>' : '';
  const items = [
    ...pendingIdeas.map((i) => `
      <li class="review-item">
        <div>
          <strong>${esc(i.title)}</strong>${linkFlag(i)}
          <div class="muted small">New idea${i.category ? ` in ${esc(i.category)}` : ''} from ${esc(i.author_name)} &lt;${esc(i.author_email)}&gt;, ${niceDate(i.created_at)}</div>
          ${i.description ? `<p>${esc(i.description)}</p>` : ''}
        </div>
        <div class="review-actions">
          <button class="btn btn-primary" type="button" data-approve-idea="${i.id}">Approve</button>
          <button class="btn" type="button" data-open="${i.id}" title="Edit, or merge into an existing idea">Edit or Merge</button>
          <button class="btn btn-danger" type="button" data-reject-idea="${i.id}">Delete</button>
        </div>
      </li>`),
    ...pendingComments.map((c) => `
      <li class="review-item">
        <div>
          <strong>Comment on “${esc(c.idea_title)}”</strong>${linkFlag(c)}
          <div class="muted small">From ${esc(c.name)} &lt;${esc(c.email)}&gt;, ${niceDate(c.created_at)}</div>
          <p>${esc(c.body)}</p>
        </div>
        <div class="review-actions">
          <button class="btn btn-primary" type="button" data-approve-comment="${c.id}">Approve</button>
          <button class="btn btn-danger" type="button" data-reject-comment="${c.id}">Delete</button>
        </div>
      </li>`),
  ];
  $('review').innerHTML = items.length
    ? `<ul class="review-list">${items.join('')}</ul>`
    : '<p class="muted" style="margin:0">Nothing waiting. New posts that need a look will show up here.</p>';
}

$('review').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.approveIdea) {
      await api(`/api/admin/ideas/${b.dataset.approveIdea}/approve`, { method: 'POST' });
      toast('Approved and published');
    } else if (b.dataset.approveComment) {
      await api(`/api/admin/comments/${b.dataset.approveComment}/approve`, { method: 'POST' });
      toast('Comment published');
    } else if (b.dataset.rejectIdea) {
      if (!confirm('Delete this idea? This can’t be undone.')) return;
      await api(`/api/admin/ideas/${b.dataset.rejectIdea}`, { method: 'DELETE' });
      toast('Deleted');
    } else if (b.dataset.rejectComment) {
      if (!confirm('Delete this comment?')) return;
      await api(`/api/admin/comments/${b.dataset.rejectComment}`, { method: 'DELETE' });
      toast('Deleted');
    } else return;
    refresh();
  } catch (err) { toast(err.message); }
});

$('require-approval').addEventListener('change', async (e) => {
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { require_approval: e.target.checked } });
    toast(e.target.checked
      ? 'New posts will wait for your review'
      : 'New posts go live right away (posts with links still wait)');
  } catch (err) { toast(err.message); }
});

$('digest-test').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const result = await api('/api/admin/digest/test', { method: 'POST', body: {} });
    toast(result.message);
  } catch (err) { toast(err.message); }
  e.target.disabled = false;
});

// ---------- Categories ----------
function renderCategories() {
  $('cat-list').innerHTML = meta.categories.map((c) => `
    <li>
      <input type="text" value="${esc(c.name)}" maxlength="40" data-cat="${c.id}" aria-label="Category name">
      <button class="btn btn-small" type="button" data-save-cat="${c.id}">Rename</button>
      <button class="btn btn-small btn-danger" type="button" data-del-cat="${c.id}">Remove</button>
    </li>`).join('') || '<li class="muted">No categories yet.</li>';
}

$('cat-list').addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save-cat]');
  const del = e.target.closest('[data-del-cat]');
  try {
    if (save) {
      const input = document.querySelector(`input[data-cat="${save.dataset.saveCat}"]`);
      await api(`/api/admin/categories/${save.dataset.saveCat}`, { method: 'PATCH', body: { name: input.value } });
      toast('Category renamed');
    } else if (del) {
      if (!confirm('Remove this category? Its suggestions become Uncategorized.')) return;
      await api(`/api/admin/categories/${del.dataset.delCat}`, { method: 'DELETE' });
      toast('Category removed');
    } else return;
    refresh();
  } catch (err) { toast(err.message); }
});

$('cat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/categories', { method: 'POST', body: { name: $('cat-name').value } });
    $('cat-name').value = '';
    toast('Category added'); refresh();
  } catch (err) { toast(err.message); }
});

// ---------- Wiring ----------
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openIdea(Number(open.dataset.open));
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  const sort = e.target.closest('th [data-sort]');
  if (sort) { view.sort = sort.dataset.sort; renderRows(); }
});
$('idea-dialog').addEventListener('click', (e) => { if (e.target === $('idea-dialog')) $('idea-dialog').close(); });
$('a-status').addEventListener('change', (e) => { view.status = e.target.value; renderRows(); });
$('a-search').addEventListener('input', (e) => { view.q = e.target.value.trim(); renderRows(); });

// Reload everything on the dashboard.
async function refresh() {
  meta = await api('/api/meta');
  renderCategories();
  await Promise.all([loadStats(), loadIdeas(), loadReview()]);
}

let started = false;
async function startDashboard() {
  $('login-form').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  await refresh();
  if (!started) {
    $('a-status').insertAdjacentHTML('beforeend', statusOptions(''));
    $('a-status').value = '';
    started = true;
  }
}

// On page load: are we already logged in? If yes, show the dashboard.
(async function start() {
  try { await api('/api/admin/me'); startDashboard(); }
  catch { showLogin(); }
})();
