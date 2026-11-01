// State, local cache, outbox and sync. `db` is null in local-only mode.
const CACHE_KEY = 'todo.cache.v1';
const OUTBOX_KEY = 'todo.outbox.v1';

let db = null;
let userId = null;
let onUpdate = () => {};
let tasks = new Map();
let outbox = [];
let status = 'synced';
let flushing = false;
let retryMs = 0;
let retryTimer = null;
let resubTimer = null;
let unsub = null;
let channelOk = false;
let listenersOn = false;

const now = () => new Date().toISOString();

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
}
function persist() {
  save(CACHE_KEY, [...tasks.values()]);
  save(OUTBOX_KEY, outbox);
}
function setStatus(s) {
  if (status === s) return;
  status = s;
  onUpdate();
}
const pending = id => outbox.some(o => (o.task ? o.task.id : o.id) === id);

function enqueue(op) {
  const id = op.task ? op.task.id : op.id;
  if (op.op === 'delete') {
    outbox = outbox.filter(o => (o.task ? o.task.id : o.id) !== id);
    outbox.push(op);
  } else {
    const i = outbox.findIndex(o => o.op === 'upsert' && o.task.id === id);
    if (i >= 0) outbox[i] = op; else outbox.push(op);
  }
}

function commit(op) {
  enqueue(op);
  persist();
  onUpdate();
  flush();
}

export async function flush() {
  if (flushing) return;
  if (!db) { outbox = []; persist(); setStatus('synced'); return; }
  flushing = true;
  clearTimeout(retryTimer);
  try {
    while (outbox.length) {
      setStatus('saving');
      const op = outbox[0];
      try {
        if (op.op === 'upsert') await db.upsertTask(op.task); else await db.deleteTask(op.id);
        outbox.shift();
        persist();
        retryMs = 0;
      } catch (e) {
        const net = !navigator.onLine || e instanceof TypeError || /fetch|network/i.test(e?.message || '');
        if (net) {
          setStatus('offline');
          retryMs = Math.min(retryMs ? retryMs * 2 : 5000, 60000);
          retryTimer = setTimeout(flush, retryMs);
          return;
        }
        console.error('Dropping op after server error', op, e);
        outbox.shift();
        persist();
      }
    }
    setStatus('synced');
  } finally {
    flushing = false;
  }
}

export async function refresh() {
  if (!db) return;
  let rows;
  try { rows = await db.fetchAll(); } catch { return; }
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    if (!pending(r.id)) tasks.set(r.id, r);
  }
  for (const id of [...tasks.keys()]) {
    if (!seen.has(id) && !pending(id)) tasks.delete(id);
  }
  persist();
  onUpdate();
}

function onRemote(type, n, o) {
  if (type === 'DELETE') {
    if (o?.id && !pending(o.id)) { tasks.delete(o.id); persist(); onUpdate(); }
    return;
  }
  if (!n || pending(n.id)) return;
  const local = tasks.get(n.id);
  if (!local || n.updated_at >= local.updated_at) {
    tasks.set(n.id, n);
    persist();
    onUpdate();
  }
}

function resubscribe() {
  if (!db || !userId) return;
  if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
  channelOk = false;
  unsub = db.subscribe(userId, onRemote, s => {
    channelOk = s === 'SUBSCRIBED';
    if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) {
      clearTimeout(resubTimer);
      resubTimer = setTimeout(resubscribe, 3000);
    }
  });
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  refresh();
  if (!channelOk) resubscribe();
  flush();
}
function onOnline() { flush().then(refresh); }
function onOffline() { setStatus('offline'); }

export async function init(dbModule, uid, cb) {
  db = dbModule;
  userId = uid;
  onUpdate = cb;
  tasks = new Map(load(CACHE_KEY, []).map(t => [t.id, t]));
  outbox = load(OUTBOX_KEY, []);
  onUpdate();
  if (db) {
    if (!listenersOn) {
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      listenersOn = true;
    }
    await flush();
    await refresh();
    resubscribe();
  } else {
    flush();
  }
}

export function teardown() {
  if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
  clearTimeout(retryTimer);
  clearTimeout(resubTimer);
  if (listenersOn) {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    listenersOn = false;
  }
  tasks = new Map();
  outbox = [];
  try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(OUTBOX_KEY); } catch { /* ignore */ }
}

export function addTask(title, notes = '') {
  const t = {
    id: crypto.randomUUID(), title, notes, done: false,
    created_at: now(), updated_at: now(), completed_at: null,
  };
  tasks.set(t.id, t);
  commit({ op: 'upsert', task: t });
  return t;
}

export function updateTask(id, patch) {
  const t = tasks.get(id);
  if (!t) return;
  const next = { ...t, ...patch, updated_at: now() };
  tasks.set(id, next);
  commit({ op: 'upsert', task: next });
}

export function toggleDone(id) {
  const t = tasks.get(id);
  if (!t) return;
  const done = !t.done;
  updateTask(id, { done, completed_at: done ? now() : null });
}

export function removeTask(id) {
  const t = tasks.get(id);
  if (!t) return null;
  tasks.delete(id);
  commit({ op: 'delete', id });
  return t;
}

export function restoreTask(t) {
  const next = { ...t, updated_at: now() };
  tasks.set(next.id, next);
  commit({ op: 'upsert', task: next });
}

export const getTask = id => tasks.get(id);
export const getStatus = () => status;
export const getOpen = () =>
  [...tasks.values()].filter(t => !t.done).sort((a, b) => b.created_at.localeCompare(a.created_at));
export const getDone = () =>
  [...tasks.values()].filter(t => t.done)
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 200);
export const countDone = () => [...tasks.values()].filter(t => t.done).length;
