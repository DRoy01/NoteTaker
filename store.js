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

export const COLORS = {
  red: '#f2637e', amber: '#f2a93b', green: '#4cc38a', teal: '#2dd4bf',
  blue: '#6f8fff', purple: '#a78bfa', pink: '#f472b6', gray: '#96a0b2',
};

const pad = n => String(n).padStart(2, '0');
export function localTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Whole calendar days for 'YYYY-MM-DD' strings (UTC math only to avoid DST drift).
const dayNum = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN;
};
const addDays = (s, n) => {
  const d = new Date((dayNum(s) + n) * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function deadlineInfo(deadline, today = localTodayString()) {
  if (!deadline) return null;
  const days = dayNum(deadline) - dayNum(today);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { days, level: 'overdue', label: `OVERDUE ${-days}D` };
  if (days === 0) return { days, level: 'today', label: 'TODAY' };
  if (days === 1) return { days, level: 'soon', label: 'TOMORROW' };
  if (days <= 3) return { days, level: 'soon', label: `IN ${days}D` };
  return { days, level: 'later', label: `${+deadline.slice(8, 10)} ${MONTHS[+deadline.slice(5, 7) - 1]}` };
}

// Fill defaults on tasks from old caches or old clients.
function normalize(t) {
  if (!t) return t;
  const ts = Date.parse(t.created_at);
  return {
    ...t,
    position: typeof t.position === 'number' && Number.isFinite(t.position)
      ? t.position : -(Number.isNaN(ts) ? Date.now() : ts),
    grp: typeof t.grp === 'string' ? t.grp : '',
    color: typeof t.color === 'string' ? t.color : '',
    deadline: t.deadline || null,
  };
}
const byPos = (a, b) => (a.position - b.position) || b.created_at.localeCompare(a.created_at);

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
    if (!pending(r.id)) tasks.set(r.id, normalize(r));
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
    tasks.set(n.id, normalize(n));
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
  tasks = new Map(load(CACHE_KEY, []).map(t => [t.id, normalize(t)]));
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
    position: tasks.size ? Math.min(...[...tasks.values()].map(x => x.position)) - 1 : -Date.now(),
    grp: '', color: '', deadline: null,
  };
  tasks.set(t.id, t);
  commit({ op: 'upsert', task: t });
  return t;
}

export function updateTask(id, patch) {
  const t = tasks.get(id);
  if (!t) return;
  const p = { ...patch };
  if ('grp' in p) p.grp = String(p.grp ?? '').trim().slice(0, 40);
  if ('color' in p && !(p.color in COLORS)) p.color = '';
  if ('deadline' in p) p.deadline = p.deadline || null;
  const next = { ...t, ...p, updated_at: now() };
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

// beforeId = neighbor now above the task, afterId = neighbor now below (null at the ends).
export function moveTask(id, beforeId, afterId) {
  const t = tasks.get(id);
  if (!t) return;
  const a = beforeId ? tasks.get(beforeId) : null;
  const b = afterId ? tasks.get(afterId) : null;
  if (!a && !b) return;
  let pos;
  if (a && b) pos = (a.position + b.position) / 2;
  else if (b) pos = b.position - 1;
  else pos = a.position + 1;
  const collide = a && b && (Math.abs(a.position - b.position) < 1e-6 || !(pos > a.position && pos < b.position));
  if (!collide) { updateTask(id, { position: pos }); return; }
  // Renumber all open tasks 0,1,2,... in current order with the moved task slotted in.
  const order = getOpen().filter(x => x.id !== id);
  let at = b ? order.findIndex(x => x.id === afterId) : order.findIndex(x => x.id === beforeId) + 1;
  if (at < 0) at = order.length;
  order.splice(at, 0, t);
  const stamp = now();
  order.forEach((x, i) => {
    if (x.position === i && x.id !== id) return;
    const next = { ...x, position: i, updated_at: stamp };
    tasks.set(x.id, next);
    enqueue({ op: 'upsert', task: next });
  });
  persist();
  onUpdate();
  flush();
}

export const getTask = id => tasks.get(id);
export const getStatus = () => status;
export const getOpen = () =>
  [...tasks.values()].filter(t => !t.done).sort(byPos);
export const getDone = () =>
  [...tasks.values()].filter(t => t.done)
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 200);
export const countDone = () => [...tasks.values()].filter(t => t.done).length;

export function getGroups() {
  const m = new Map();
  for (const t of tasks.values()) {
    if (t.grp) m.set(t.grp, (m.get(t.grp) || 0) + (t.done ? 0 : 1));
  }
  return [...m].map(([name, open]) => ({ name, open }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function query({ view = 'all', group = null, sort = 'asc', filter = 'all', from = '', to = '' } = {}) {
  let list = getOpen();
  if (view === 'groups') {
    if (group !== null && group !== undefined) list = list.filter(t => t.grp === group);
    return list;
  }
  if (view !== 'deadlines') return list;
  const today = localTodayString();
  const keep = {
    overdue: d => d < today,
    today: d => d === today,
    week: d => d >= today && d <= addDays(today, 6),
    custom: d => (!from || d >= from) && (!to || d <= to),
  }[filter];
  if (keep) list = list.filter(t => t.deadline && keep(t.deadline));
  const dir = sort === 'desc' ? -1 : 1;
  // getOpen() is already in position order and Array.sort is stable, so ties keep it.
  return list.sort((a, b) => {
    if (!a.deadline || !b.deadline) return a.deadline ? -1 : b.deadline ? 1 : 0;
    return (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0) * dir;
  });
}
