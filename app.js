import * as store from './store.js';
import { SUPABASE_URL } from './config.js';

const $ = id => document.getElementById(id);
const LOCAL_MODE = SUPABASE_URL.includes('YOUR-');

let db = null;
let tab = 'open';
let openId = null;
let saveTimer = null;
let toastTimer = null;
let undoTask = null;
let rafPending = false;

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

  const list = $('task-list');
  const rows = tab === 'open' ? open : done;
  list.replaceChildren(...rows.map(rowEl));
  const empty = $('empty');
  empty.hidden = rows.length > 0;
  empty.textContent = tab === 'open' ? 'Nothing on your mind. Nice.' : 'Finished tasks land here.';

  renderPanel();
}

function rowEl(t) {
  const li = document.createElement('li');
  li.dataset.id = t.id;
  if (t.done) li.classList.add('done');
  if (t.id === openId) li.classList.add('selected');

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
  if (t.notes && t.notes.trim()) {
    const m = document.createElement('span');
    m.className = 'note-mark';
    m.textContent = '¶';
    li.appendChild(m);
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
    if (!li) return;
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
    if (session) startApp(session.user.id);
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

async function startApp(userId) {
  $('view-signin').hidden = true;
  $('view-list').hidden = false;
  $('signout').hidden = LOCAL_MODE;
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
  if (session) startApp(session.user.id); else showSignIn();
}

main();
