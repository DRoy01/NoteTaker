import * as store from './store.js';
import { SUPABASE_URL } from './config.js';
import { enableDrag } from './drag.js';

const $ = id => document.getElementById(id);
const LOCAL_MODE = SUPABASE_URL.includes('YOUR-');
const ALL_KEY = '\u0000all';

let db = null;
let tab = 'open';
let openId = null;
let saveTimer = null;
let toastTimer = null;
let undoTask = null;
let rafPending = false;

/* ---------- view state (persisted) ---------- */
const VIEW_KEY = 'todo.view.v1';
const DEFAULT_VIEW = { view: 'all', group: null, sort: 'asc', filter: 'all', from: '', to: '' };
let vs = loadView();

function loadView() {
  const v = { ...DEFAULT_VIEW };
  try {
    const o = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (o && typeof o === 'object') {
      if (['all', 'groups', 'deadlines'].includes(o.view)) v.view = o.view;
      if (o.group === null || typeof o.group === 'string') v.group = o.group;
      if (['asc', 'desc'].includes(o.sort)) v.sort = o.sort;
      if (['all', 'overdue', 'today', 'week', 'custom'].includes(o.filter)) v.filter = o.filter;
      if (typeof o.from === 'string') v.from = o.from;
      if (typeof o.to === 'string') v.to = o.to;
    }
  } catch {}
  return v;
}
function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(vs)); } catch {} }
const canDrag = () => tab === 'open' && vs.view !== 'deadlines';
const filterActive = () =>
  (vs.view === 'groups' && vs.group !== null) || (vs.view === 'deadlines' && vs.filter !== 'all');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* ---------- rendering ---------- */
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function render() {
  const open = store.getOpen();
  const done = store.getDone();
  $('count-label').textContent = `Tasks · ${open.length} open`;
  $('n-open').textContent = open.length;
  $('n-done').textContent = store.countDone();

  const pill = $('status-pill');
  const s = store.getStatus();
  pill.dataset.status = s;
  pill.lastElementChild.textContent = s === 'saving' ? 'Saving…' : s === 'offline' ? 'Offline' : 'Synced';

  // a saved group that no longer exists falls back to ALL
  if (vs.group !== null) {
    const ok = vs.group === '' ? open.some(t => !t.grp) : store.getGroups().some(g => g.name === vs.group);
    if (!ok) { vs.group = null; saveView(); }
  }

  const list = $('task-list');
  const filtered = tab === 'open' ? store.query(vs) : null;
  const rows = tab === 'open' ? filtered : done;
  const kids = [];
  let dividerDone = false;
  for (const t of rows) {
    if (tab === 'open' && vs.view === 'deadlines' && !t.deadline && !dividerDone) {
      dividerDone = true;
      const d = document.createElement('li');
      d.className = 'divider';
      d.setAttribute('role', 'presentation');
      d.textContent = 'No deadline';
      kids.push(d);
    }
    kids.push(rowEl(t));
  }
  const ae = document.activeElement;
  const gripId = ae && ae.classList && ae.classList.contains('grip') ? ae.closest('li')?.dataset.id : null;
  list.replaceChildren(...kids);
  if (gripId) list.querySelector(`li[data-id="${CSS.escape(gripId)}"] .grip`)?.focus();
  list.classList.toggle('no-drag', !canDrag());
  const empty = $('empty');
  empty.hidden = rows.length > 0;
  empty.textContent = tab === 'done' ? 'Finished tasks land here.'
    : open.length ? 'Nothing matches.' : 'Nothing on your mind. Nice.';

  renderViews(open, filtered);
  renderPanel();
}

function renderViews(open, filtered) {
  const bar = $('views');
  bar.hidden = tab !== 'open';
  if (bar.hidden) return;
  document.querySelectorAll('#view-seg button').forEach(b => b.classList.toggle('on', b.dataset.view === vs.view));
  document.querySelectorAll('#sort-seg button').forEach(b => b.classList.toggle('on', b.dataset.sort === vs.sort));
  document.querySelectorAll('#filter-seg button').forEach(b => b.classList.toggle('on', b.dataset.filter === vs.filter));
  $('dl-controls').hidden = vs.view !== 'deadlines';
  $('custom-range').hidden = vs.view !== 'deadlines' || vs.filter !== 'custom';
  if (document.activeElement !== $('f-from')) $('f-from').value = vs.from;
  if (document.activeElement !== $('f-to')) $('f-to').value = vs.to;

  const chips = $('group-chips');
  chips.hidden = vs.view !== 'groups';
  if (!chips.hidden) {
    const mk = (name, label, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gchip' + (vs.group === name ? ' on' : '');
      b.dataset.group = name === null ? ALL_KEY : name;
      b.setAttribute('aria-pressed', String(vs.group === name));
      b.append(label);
      const c = document.createElement('span');
      c.textContent = n;
      b.appendChild(c);
      return b;
    };
    const ungrouped = open.filter(t => !t.grp).length;
    const items = [mk(null, 'All', open.length)];
    for (const g of store.getGroups()) items.push(mk(g.name, g.name, g.open));
    if (ungrouped || vs.group === '') items.push(mk('', 'Ungrouped', ungrouped));
    chips.replaceChildren(...items);
  }
  const sh = $('showing');
  sh.hidden = !filterActive();
  sh.textContent = 'SHOWING ' + filtered.length;
}

function chipEl(t) {
  const info = store.deadlineInfo(t.deadline);
  if (!info) return null;
  const lvl = t.done ? 'later' : info.level;
  const c = document.createElement('span');
  c.className = 'dl-chip lvl-' + lvl;
  c.textContent = info.label;
  return c;
}

function rowEl(t) {
  const li = document.createElement('li');
  li.dataset.id = t.id;
  if (t.done) li.classList.add('done');
  if (t.id === openId) li.classList.add('selected');
  if (t.color && store.COLORS[t.color]) li.style.setProperty('--stripe', store.COLORS[t.color]);

  const cb = document.createElement('button');
  cb.type = 'button';
  cb.className = 'check';
  cb.dataset.act = 'toggle';
  cb.setAttribute('aria-label', t.done ? 'Reopen task' : 'Complete task');
  cb.appendChild(document.createElement('span'));

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = t.title;

  li.append(cb, title);

  const meta = document.createElement('span');
  meta.className = 'meta';
  if (t.grp) {
    const g = document.createElement('span');
    g.className = 'chip';
    g.textContent = t.grp;
    meta.appendChild(g);
  }
  const dc = chipEl(t);
  if (dc) meta.appendChild(dc);
  if (meta.firstChild) li.appendChild(meta);

  if (t.notes && t.notes.trim()) {
    const m = document.createElement('span');
    m.className = 'note-mark';
    m.textContent = '¶';
    li.appendChild(m);
  }
  if (canDrag()) {
    const g = document.createElement('button');
    g.type = 'button';
    g.className = 'grip';
    g.setAttribute('aria-label', 'Drag to reorder');
    li.appendChild(g);
  }
  return li;
}

function autoGrow() {
  const ta = $('d-notes');
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight, 8 * 25) + 'px';
}

function renderPanel() {
  const panel = $('panel-detail');
  const t = openId && store.getTask(openId);
  if (!t) { if (openId) closePanel(false); return; }
  panel.hidden = false;
  $('view-list').classList.add('with-panel');
  // don't clobber text the user is typing (store rule 6)
  if (document.activeElement !== $('d-title')) $('d-title').value = t.title;
  if (document.activeElement !== $('d-notes')) { $('d-notes').value = t.notes; autoGrow(); }

  const names = store.getGroups().map(g => g.name);
  const sig = names.join('\u0000');
  const dl = $('groups-list');
  if (dl.dataset.sig !== sig) {
    dl.dataset.sig = sig;
    dl.replaceChildren(...names.map(n => { const o = document.createElement('option'); o.value = n; return o; }));
  }
  if (document.activeElement !== $('d-group')) $('d-group').value = t.grp || '';
  document.querySelectorAll('#d-colors .sw').forEach(b =>
    b.setAttribute('aria-checked', String(b.dataset.color === (t.color || ''))));
  if (document.activeElement !== $('d-deadline')) $('d-deadline').value = t.deadline || '';
  const chip = $('d-dl-chip');
  const dc = chipEl(t);
  chip.hidden = !dc;
  if (dc) { chip.className = dc.className + ' big'; chip.textContent = dc.textContent; }
  $('d-dl-clear').hidden = !t.deadline;

  const d = new Date(t.created_at);
  $('d-meta').textContent = 'Added ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---------- detail panel ---------- */
function openPanel(id) {
  openId = id;
  render();
  if (matchMedia('(min-width: 900px)').matches) $('d-notes').focus();
}

function savePanel() {
  clearTimeout(saveTimer);
  const t = openId && store.getTask(openId);
  if (!t) return;
  const title = $('d-title').value.trim() || t.title;
  const notes = $('d-notes').value;
  if (title !== t.title || notes !== t.notes) store.updateTask(openId, { title, notes });
}

function closePanel(save = true) {
  if (save) savePanel();
  openId = null;
  $('panel-detail').hidden = true;
  $('view-list').classList.remove('with-panel');
  if (save) render();
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePanel, 600);
}

/* ---------- toast ---------- */
function showToast(text, task) {
  undoTask = task;
  $('toast-text').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoTask = null; }, 5000);
}

/* ---------- events ---------- */
function bind() {
  $('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('add-input');
    const text = input.value.trim();
    if (!text) return;
    const nl = text.indexOf('\n');
    const title = (nl >= 0 ? text.slice(0, nl) : text).trim().slice(0, 500);
    const notes = nl >= 0 ? text.slice(nl + 1).trim() : '';
    if (!title) return;
    store.addTask(title, notes);
    input.value = '';
    input.focus();
    if (tab !== 'open') setTab('open');
  });

  $('task-list').addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li || !li.dataset.id || e.target.closest('.grip')) return;
    if (e.target.closest('[data-act="toggle"]')) {
      store.toggleDone(li.dataset.id);
    } else {
      if (openId && openId !== li.dataset.id) savePanel();
      openPanel(li.dataset.id);
    }
  });

  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  $('d-title').addEventListener('input', queueSave);
  $('d-title').addEventListener('blur', savePanel);
  $('d-notes').addEventListener('input', () => { autoGrow(); queueSave(); });
  $('d-notes').addEventListener('blur', savePanel);
  $('d-notes').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) closePanel();
  });
  $('panel-close').addEventListener('click', () => closePanel());

  // group / color / deadline save immediately
  const patchOpen = patch => { if (openId) store.updateTask(openId, patch); };
  $('d-group').addEventListener('change', () => patchOpen({ grp: $('d-group').value.trim().slice(0, 40) }));
  $('d-deadline').addEventListener('change', () => patchOpen({ deadline: $('d-deadline').value || null }));
  $('d-dl-clear').addEventListener('click', () => { $('d-deadline').value = ''; patchOpen({ deadline: null }); });
  const mkSw = (key, hex, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw' + (key ? '' : ' none');
    b.dataset.color = key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', label);
    const i = document.createElement('i');
    if (hex) i.style.setProperty('--c', hex);
    b.appendChild(i);
    return b;
  };
  const sw = $('d-colors');
  sw.append(...Object.entries(store.COLORS).map(([k, h]) => mkSw(k, h, k)), mkSw('', '', 'No color'));
  sw.addEventListener('click', e => {
    const b = e.target.closest('.sw');
    if (b) patchOpen({ color: b.dataset.color });
  });

  // views bar
  const upd = patch => { Object.assign(vs, patch); saveView(); render(); };
  $('view-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) upd({ view: b.dataset.view }); });
  $('sort-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) upd({ sort: b.dataset.sort }); });
  $('filter-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) upd({ filter: b.dataset.filter }); });
  $('group-chips').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) upd({ group: b.dataset.group === ALL_KEY ? null : b.dataset.group });
  });
  $('f-from').addEventListener('change', () => upd({ from: $('f-from').value }));
  $('f-to').addEventListener('change', () => upd({ to: $('f-to').value }));

  enableDrag($('task-list'), {
    onMove: (id, beforeId, afterId) => { store.moveTask(id, beforeId, afterId); scheduleRender(); },
    canDrag,
  });

  $('d-delete').addEventListener('click', () => {
    if (!openId) return;
    const removed = store.removeTask(openId);
    closePanel(false);
    render();
    if (removed) showToast('Deleted', removed);
  });

  $('toast-undo').addEventListener('click', () => {
    if (undoTask) store.restoreTask(undoTask);
    undoTask = null;
    $('toast').hidden = true;
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openId) { closePanel(); return; }
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '/' || e.key === 'n')) {
      e.preventDefault();
      $('add-input').focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePanel();
  });
  window.addEventListener('pagehide', savePanel);

  $('signout').addEventListener('click', async () => {
    savePanel();
    store.teardown();
    if (db) await db.signOut();
    openId = null;
    showSignIn();
  });

  $('signin-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('si-error').textContent = '';
    const { error } = await db.signIn($('si-email').value.trim(), $('si-pass').value);
    if (error) { $('si-error').textContent = error.message; return; }
    $('si-pass').value = '';
    const session = await db.getSession();
    if (session) startApp(session.user.id, session.user.email);
  });
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  render();
}

/* ---------- boot ---------- */
function showSignIn() {
  $('view-list').hidden = true;
  $('view-signin').hidden = false;
}

function showUser(email) {
  const name = LOCAL_MODE ? 'Local' : (email || '').split('@')[0];
  $('username').hidden = !name;
  $('user-name').textContent = name;
  $('user-initial').textContent = name.charAt(0).toUpperCase();
  $('username').title = email || '';
}

async function startApp(userId, email) {
  $('view-signin').hidden = true;
  $('view-list').hidden = false;
  $('signout').hidden = LOCAL_MODE;
  showUser(email);
  await store.init(db, userId, scheduleRender);
}

async function main() {
  bind();
  if (LOCAL_MODE) {
    await startApp('local');
    return;
  }
  db = await import('./db.js');
  const session = await db.getSession().catch(() => null);
  if (session) startApp(session.user.id, session.user.email); else showSignIn();
}

main();
