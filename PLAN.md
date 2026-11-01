# Synced To-Do — Implementation Plan

A small, fast to-do app for one person. It is used on a Windows PC and an iPhone, and every change syncs between them in real time.
This document is the full spec. An agent running on any model should be able to build the app from it phase by phase.

---

## 0. Rules for the implementing agent

1. **Work through the phases in §10 in order.** Finish a phase's acceptance checks before you start the next one.
2. **Use no framework and no build step.** Write plain HTML, CSS and JavaScript (ES modules). Don't use npm, bundlers, React or TypeScript.
3. **Load third-party code from a CDN, pinned to an exact version.** The only runtime dependency is `@supabase/supabase-js@2.45.4`.
4. **Keep it small.** Aim for under 700 lines of JS in total. If a feature isn't in §1, don't build it.
5. **Steps marked `[USER]` need the human.** These are creating accounts and pasting keys. Stop, tell the user exactly what to do, and wait.
6. **Never commit secrets.** The Supabase URL and the anon/publishable key are *meant* to be public, because Row Level Security protects the data. Never put a `service_role` / secret key in any file.
7. Follow the design tokens in §5 exactly. Don't invent new colors.
8. After each phase, give the user a 3–5 line summary of what works now and how to try it.

---

## 1. Product spec

### Must have (v1)
| # | Feature | Detail |
|---|---------|--------|
| F1 | **Quick add** | An input is always visible at the top. Type and press Enter, and the task appears instantly. The input clears and keeps focus. |
| F2 | **Task details** | Tap or click a task to open a detail panel. It has an editable title and a multi-line **notes** field. Notes autosave (no Save button). |
| F3 | **Complete / reopen** | A round checkbox on each row. Done tasks move to the "Done" view. |
| F4 | **Delete** | Delete from the detail panel. A toast shows "Deleted · Undo" for 5 s. |
| F5 | **Real-time sync** | A change on one device appears on the other within ~2 s while both are open. When an app is reopened it is up to date within ~1 s. |
| F6 | **Works offline** | The last-known list shows offline. Adds and edits made offline sync automatically when the connection returns. |
| F7 | **Installable** | It's a PWA. On iPhone it goes on the Home Screen (full-screen, own icon). On PC it installs from Chrome/Edge (own window). |
| F8 | **Private** | One user. Email + password sign-in. You stay signed in. Public sign-ups are disabled. |
| F9 | **Fast** | The list renders from the local cache before the network responds. No spinners for normal actions. |

### Not in v1 (don't build)
Due dates, reminders/notifications, categories/tags, multiple lists, drag-to-reorder, sharing, light theme. These are listed in §12 as future ideas.

---

## 2. Architecture

```
 ┌──────────── PC (Chrome/Edge PWA) ───────────┐      ┌──────── iPhone (Safari Home-Screen PWA) ────────┐
 │ index.html + app.js + db.js                 │      │ same files, same code                           │
 │ localStorage: cache + outbox                │      │ localStorage: cache + outbox                    │
 └───────────────┬─────────────────────────────┘      └───────────────┬─────────────────────────────────┘
                 │ HTTPS (REST)  +  WebSocket (Realtime)              │
                 └──────────────────────┬─────────────────────────────┘
                                        ▼
                         ┌──────────── Supabase (free tier) ────────────┐
                         │ Auth (email+password, signups disabled)      │
                         │ Postgres table `tasks` with RLS              │
                         │ Realtime: postgres_changes on `tasks`        │
                         └──────────────────────────────────────────────┘
 Static files hosted on GitHub Pages (HTTPS, free).
```

| Layer | Choice | Why |
|---|---|---|
| UI | Vanilla HTML/CSS/JS modules | No build, so any model can edit it safely |
| Data + auth + sync | Supabase | Free; Postgres, auth and realtime in one |
| Hosting | GitHub Pages | Free HTTPS, which service workers require |
| Offline | localStorage cache + outbox queue | Simple and good enough for a few hundred tasks |

---

## 3. File structure

```
todo-app/
├── PLAN.md                 ← this file
├── README.md               ← short: what it is, how to deploy, how to install on devices
├── index.html              ← markup for all three views, meta tags, font links
├── styles.css              ← all styling (tokens from §5)
├── config.js               ← SUPABASE_URL + SUPABASE_KEY (public values)
├── db.js                   ← the ONLY file that talks to Supabase
├── store.js                ← in-memory state, cache, outbox, sync logic
├── app.js                  ← entry point: rendering + event handlers
├── sw.js                   ← service worker (offline app shell)
├── manifest.webmanifest
├── icons/
│   ├── icon.svg            ← source icon
│   ├── icon-192.png
│   ├── icon-512.png
│   └── apple-touch-icon.png  (180×180)
├── scripts/
│   └── make_icons.py       ← renders the PNGs from scratch with Pillow
└── supabase/
    └── schema.sql          ← run once in Supabase SQL editor
```

---

## 4. Backend (Supabase)

### 4.1 `[USER]` Create the project
1. Sign up at https://supabase.com (GitHub login is easiest) and create a **New project**. Pick any name and the region nearest you, and save the DB password somewhere.
2. Go to **Project Settings → API**. Copy the **Project URL** and the **anon / publishable key** into `config.js`.
3. Go to **Authentication → Sign In / Providers → Email**. Keep Email enabled, and **turn OFF "Allow new users to sign up"**.
4. Go to **Authentication → Users → Add user → Create new user**. Enter your email and a password, and tick **Auto confirm user**.
5. Go to **SQL Editor → New query**, paste `supabase/schema.sql`, and click Run.

> Note: free projects pause after about 7 days with no activity. Daily use keeps it awake. If it does pause, click "Restore" in the dashboard.

### 4.2 `supabase/schema.sql` (exact content)
```sql
create table if not exists public.tasks (
  id            uuid primary key,                       -- generated on the client (crypto.randomUUID)
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 500),
  notes         text not null default '',
  done          boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),     -- set by the client on every change (last-write-wins)
  completed_at  timestamptz
);

create index if not exists tasks_user_idx on public.tasks (user_id, done, created_at desc);

alter table public.tasks enable row level security;

create policy "own tasks: select" on public.tasks for select using (auth.uid() = user_id);
create policy "own tasks: insert" on public.tasks for insert with check (auth.uid() = user_id);
create policy "own tasks: update" on public.tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own tasks: delete" on public.tasks for delete using (auth.uid() = user_id);

-- realtime
alter publication supabase_realtime add table public.tasks;
```

### 4.3 `config.js`
```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_KEY = 'YOUR-ANON-OR-PUBLISHABLE-KEY';
```

---

## 5. Design system

The look matches the user's "How a network learns XOR" page: a dark blueprint grid background, rounded dark cards with thin borders, small **uppercase monospace eyebrow labels** with wide letter-spacing, **heavy tight display headings**, muted body text, and amber / pink / blue accents. A handwritten font is used for small asides.

### 5.1 Fonts (Google Fonts, one `<link>`, `display=swap`)
- Display: **Inter Tight** 800, letter-spacing `-0.04em`, line-height 1.0
- Body / UI: **IBM Plex Sans** 400 / 600
- Labels, counts, buttons, status: **IBM Plex Mono** 500, uppercase, letter-spacing `0.14em`, 12px
- Handwritten asides (empty states, the hint under the input): **Caveat** 500, 20px, muted color

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;600&family=Inter+Tight:wght@800&display=swap" rel="stylesheet">
```

### 5.2 Tokens (put these at the top of `styles.css`)
```css
:root {
  --bg:        #11141b;
  --grid:      rgba(255,255,255,0.035);   /* 32px blueprint grid lines */
  --surface:   #171b24;                   /* cards, panel, input */
  --surface-2: #1d2230;                   /* hover / active row */
  --border:    #262c39;
  --text:      #e9ecf3;
  --muted:     #96a0b2;
  --dim:       #5f6879;
  --amber:     #f2a93b;   /* primary accent: checkbox fill, focus ring, add button */
  --pink:      #f2637e;   /* destructive + "offline" status */
  --blue:      #6f8fff;   /* links, "synced" status, notes indicator */
  --radius:    14px;
  --font-display: 'Inter Tight', system-ui, sans-serif;
  --font-body:    'IBM Plex Sans', system-ui, sans-serif;
  --font-mono:    'IBM Plex Mono', ui-monospace, monospace;
  --font-hand:    'Caveat', cursive;
  color-scheme: dark;
}
body {
  margin: 0; background-color: var(--bg); color: var(--text); font: 16px/1.55 var(--font-body);
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 32px 32px;
}
```

### 5.3 Component styling
- **Eyebrow label**: mono, uppercase, `--muted`, 12px, `letter-spacing: .14em`. Example: `TASKS · 7 OPEN`.
- **Heading**: display font, `clamp(40px, 8vw, 72px)`, `--text`.
- **Card / panel**: `--surface`, `1px solid var(--border)`, `--radius`, padding 20px.
- **Quick-add input**: a full-width card style, 18px text, placeholder "What's on your mind?". On focus the border is `--amber` with `box-shadow: 0 0 0 3px rgba(242,169,59,.18)`.
- **Checkbox**: a 22px circle with a 2px `--muted` border, like the network nodes in the reference. When done it is filled `--amber` with a dark check mark. The hit area is at least 44×44px for iPhone.
- **Task row**: 14px vertical padding, divided by a `1px var(--border)` line, with `--surface-2` on hover. Done rows show the title in `--dim` with `line-through`. A row with notes shows a small blue `¶` after the title.
- **Tabs (Open / Done)**: mono links with a 1px underline, like the "1 · the puzzle" nav in the reference. The active tab is `--text` and the others `--muted`. Each shows a count: `OPEN 7`, `DONE 23`.
- **Sync status pill** (top right): mono 11px, with a 6px dot before it. `SYNCED` has a blue dot, `SAVING…` amber, `OFFLINE` pink.
- **Toast**: bottom-centered card with the text and an amber `UNDO` mono button. Auto-hides after 5 s.
- **Motion**: only `transition: background .12s, opacity .15s, transform .18s`. Nothing bouncy. Respect `prefers-reduced-motion`.
- **Layout**: max content width 760px, centered, 16px side gutters on phones. No horizontal scroll at 360px width. Use `env(safe-area-inset-*)` padding for the iPhone notch and home bar.

---

## 6. UI spec

### 6.1 Views
There are three views in one `index.html`, toggled with the `hidden` attribute: `#view-signin`, `#view-list`, `#panel-detail` (the panel overlays the list).

**Sign-in** (shown only when there is no session):
```
 SYNCED TO-DO
 Sign in
 [ email               ]
 [ password            ]
 [ SIGN IN ]                ← amber button, mono label
 (pink error text on failure)
```

**List (desktop, ≥ 900px wide). The detail panel docks on the right:**
```
 TASKS · 7 OPEN                                   ● SYNCED
 What's next?
 ┌────────────────────────────────────────────┐  ┌─ DETAIL ────────────────── ✕ ┐
 │ What's on your mind?                    ⏎  │  │ [Title, editable          ]  │
 └────────────────────────────────────────────┘  │ NOTES                        │
 OPEN 7   DONE 23                                │ ┌──────────────────────────┐ │
 ○ Email landlord about heater         ¶         │ │ multi-line notes…        │ │
 ○ Buy printer ink                               │ └──────────────────────────┘ │
 ○ Read chapter 4 of NN book           ¶         │ ADDED 29 OCT · 14:02         │
                                                 │ [ DELETE ]   (pink, mono)    │
                                                 └──────────────────────────────┘
```

**List (phone, < 900px). The detail panel is a full-screen sheet that slides up:**
```
 TASKS · 7 OPEN   ● SYNCED
 What's next?
 [ What's on your mind?      + ]
 OPEN 7   DONE 23
 ○ Email landlord about heater ¶
 ○ Buy printer ink
```
On the phone, the sheet has a `‹ BACK` mono button top-left instead of ✕.

### 6.2 Behaviour
- **Add**: on Enter (or the `+` button on phone), trim the text and ignore it if empty. Create the task with `crypto.randomUUID()`, insert it at the top of Open, clear the input, and keep focus. If the text has a newline, only the first line becomes the title. The rest goes into notes.
- **Open detail**: click/tap anywhere on a row except the checkbox. On desktop, focus the notes textarea. On phone, don't auto-focus, so the keyboard doesn't pop up.
- **Edit title / notes**: save 600 ms after the last keystroke. Also save immediately on blur, on panel close, and on `visibilitychange → hidden`. The notes textarea auto-grows to fit its content (minimum 8 rows).
- **Toggle done**: set `done`, set `completed_at = now` (or `null` when reopening), and update `updated_at`.
- **Delete**: remove the task locally and show the undo toast. If Undo is pressed within 5 s, re-insert the same task (same id). Otherwise the delete op goes to the server.
- **Sorting**: Open tasks are newest first (`created_at desc`). Done tasks are most recently completed first (`completed_at desc`). Show at most 200 done tasks.
- **Empty states** (Caveat, muted, centered): Open is empty → *"Nothing on your mind. Nice."* Done is empty → *"Finished tasks land here."*
- **Header count**: `TASKS · {n} OPEN`.
- **Keyboard (desktop)**: `/` or `n` focuses quick-add (when not typing). `Esc` closes the panel. `Ctrl+Enter` in notes closes the panel.
- **Sign out**: a small mono `SIGN OUT` link at the very bottom of the list view.
- **Escaping**: insert all user text with `textContent`, never `innerHTML`.

---

## 7. Code contracts

### 7.1 Task shape (identical in JS and DB)
```js
{ id, title, notes, done, created_at, updated_at, completed_at }  // ISO strings for dates; user_id is left to the DB default
```

### 7.2 `db.js` — the only Supabase access
```js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export async function getSession()            // → session | null
export async function signIn(email, password)  // → { error }
export async function signOut()
export function onAuthChange(cb)               // wraps sb.auth.onAuthStateChange
export async function fetchAll()               // → Task[] (select id,title,notes,done,created_at,updated_at,completed_at)
export async function upsertTask(task)         // sb.from('tasks').upsert(task) ; throws on error
export async function deleteTask(id)           // sb.from('tasks').delete().eq('id', id) ; throws on error
export function subscribe(userId, onChange, onStatus)
  // sb.channel('tasks-' + userId)
  //   .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` },
  //       p => onChange(p.eventType, p.new, p.old))
  //   .subscribe(status => onStatus(status));   // 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'
  // returns an unsubscribe() function (sb.removeChannel)
```

### 7.3 `store.js` — state, cache, outbox, sync
State:
```js
tasks:   Map<id, Task>
outbox:  Array<{ op: 'upsert', task } | { op: 'delete', id }>
status:  'synced' | 'saving' | 'offline'
```
localStorage keys (wrap every access in try/catch):
- `todo.cache.v1`: JSON array of tasks
- `todo.outbox.v1`: JSON outbox

Public API (app.js uses only these):
```js
init(userId, onUpdate)      // load cache → onUpdate() → refresh() → subscribe → flush()
addTask(title, notes='')
updateTask(id, patch)       // merges patch, sets updated_at = new Date().toISOString()
toggleDone(id)
removeTask(id)              // returns the removed task (for undo)
restoreTask(task)           // undo: upsert the same task again
refresh()                   // fetchAll + reconcile
getOpen(), getDone(), getTask(id), getStatus()
teardown()                  // unsubscribe, clear timers (on sign-out); also clears cache + outbox
```

**Rules for the sync logic. Follow these exactly:**
1. **Every mutation** applies locally first, then saves the cache, pushes onto the outbox, calls `onUpdate()`, then calls `flush()`.
2. **Coalesce the outbox**: when pushing an `upsert` for an id that already has a pending `upsert`, replace that entry in place. When pushing a `delete`, drop any pending `upsert` for that id.
3. **`flush()`**: if a flush is already running, return. Process ops from the front, one at a time. Remove an op only after the server confirms it. On a **network error** (`TypeError: Failed to fetch`, or `navigator.onLine === false`), stop, set status `offline`, and retry in 5 s, then 10, 20, up to a cap of 60 s. On any **other error** (e.g. a 4xx), drop that op, `console.error` it, and continue. When the outbox is empty, set status `synced`. While ops remain, the status is `saving`.
4. **`refresh()` reconcile**: for each server row, if the outbox has **no** pending op for that id, take the server version. Local tasks that are missing on the server and have no pending op are **removed** (they were deleted on the other device). Save the cache, then call `onUpdate()`.
5. **Realtime events**: ignore any event whose id has a pending outbox op. `INSERT`/`UPDATE`: apply if `!local || new.updated_at >= local.updated_at`. `DELETE`: remove `old.id`. Save the cache and call `onUpdate()`.
6. **Don't clobber typing**: if the detail panel for that task is open and the notes or title field is focused, apply the change to state but don't rewrite the field's value. app.js checks `document.activeElement` before setting values.
7. **Resume / reconnect** (critical on iPhone, because iOS kills sockets in the background):
   - on `visibilitychange` → `visible`: `refresh()`, re-subscribe if the channel isn't `SUBSCRIBED`, then `flush()`
   - on `online`: `flush()`, then `refresh()`
   - on `offline`: set status `offline`
   - on channel status `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`: re-subscribe after 3 s

### 7.4 `app.js`
- On load: register `sw.js`, then call `getSession()`. With no session, show sign-in. With a session, call `store.init(...)`.
- `render()` rebuilds only the list `<ul>` and the counts from `getOpen()` / `getDone()`. Build rows with `document.createElement`, using one delegated click listener on the `<ul>`. Use `data-id` on each `<li>`.
- The panel has its own `renderPanel(id)`. It updates the title and notes fields only when they're not focused (rule 6).
- Throttle `render()` with `requestAnimationFrame`.

---

## 8. PWA

### 8.1 `index.html` head (required tags)
```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#11141b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="To-Do">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<title>To-Do</title>
<script type="module" src="app.js"></script>
```
Also set `font-size: 16px` or larger on every input and textarea. Otherwise iOS Safari zooms in on focus.

### 8.2 `manifest.webmanifest`
```json
{
  "name": "Synced To-Do",
  "short_name": "To-Do",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#11141b",
  "theme_color": "#11141b",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

### 8.3 `sw.js`
- `const CACHE = 'todo-v1';` **Bump this on every deploy.**
- `install`: pre-cache `./`, `index.html`, `styles.css`, `app.js`, `store.js`, `db.js`, `config.js`, `manifest.webmanifest`, and the icons. Then call `skipWaiting()`.
- `activate`: delete the old caches, then call `clients.claim()`.
- `fetch`:
  - Requests to `*.supabase.co`: **don't intercept** (just `return`).
  - Non-GET requests: don't intercept.
  - Everything else (same-origin, jsdelivr, Google Fonts): **stale-while-revalidate**. Serve from cache if present, and fetch to update the cache in the background.

### 8.4 Icon
`icons/icon.svg`: a `#11141b` rounded square, with an amber (`#f2a93b`) circle in the center (about 56% of the width) and a dark check mark inside it. `scripts/make_icons.py` uses Pillow to draw the same design at 192, 512 and 180 (apple-touch, with no transparency and the full square filled). Run it with `python scripts/make_icons.py`. If Python or Pillow is missing, tell the user and install Pillow with `pip install pillow`.

---

## 9. Deployment

### 9.1 `[USER]` GitHub Pages
1. Create a GitHub account if you don't have one, then create a **public** repo named `todo`. (GitHub Pages on a private repo needs a paid plan. The code has no secrets, so public is fine.)
2. The agent runs: `git init`, commit, `git branch -M main`, `git remote add origin https://github.com/<user>/todo.git`, `git push -u origin main`. The user may need to sign in to GitHub the first time.
3. In the repo, go to **Settings → Pages → Source: Deploy from a branch → main / (root)**.
4. The app goes live at `https://<user>.github.io/todo/` after about 1 minute.

> All paths in the app must be **relative** (`./app.js`, not `/app.js`), because the site lives under `/todo/`.

### 9.2 `[USER]` Install on devices
- **iPhone**: open the URL in **Safari** (not Chrome), then Share → **Add to Home Screen**. Open it *from the Home Screen icon* and sign in there. The Home Screen app has its own storage, separate from Safari, so you sign in once inside it.
- **PC**: open the URL in Chrome or Edge, then click the install icon in the address bar (or ⋯ → Apps → Install). Pin it to the taskbar.

### 9.3 Updating later
Edit the files, bump `CACHE` in `sw.js`, then commit and push. Devices pick up the new version on the next launch, or the one after.

---

## 10. Phases and acceptance checks

### Phase 1: Local-only UI
Build `index.html`, `styles.css`, `app.js` and a temporary in-memory `store.js` with the same API, persisted to localStorage, with no Supabase yet.
**Check**: Serve with `python -m http.server 8080` in `todo-app/` and open http://localhost:8080. Add, open details, edit notes, complete, reopen, delete and undo all work. A reload keeps the data. The layout looks right at 375px wide and at 1280px. The design matches §5.

### Phase 2: Supabase auth + data `[USER]` steps from §4.1
Add `config.js`, `db.js` and `supabase/schema.sql`. Implement sign-in and sign-out, and connect the store to `fetchAll` / `upsertTask` / `deleteTask` through the outbox (§7.3 rules 1–4).
**Check**: Sign in. Add a task and it appears in Supabase **Table Editor → tasks**. Edit the row's notes in the Table Editor and reload, and the app shows the change. A wrong password shows the pink error.

### Phase 3: Realtime + resume
Add `subscribe` and rules 5–7.
**Check**: Open the app in two browser windows (or a normal and a private window, both signed in). Add, edit, complete and delete in one window. The other updates within ~2 s with no reload. Typing notes in window A while window B edits the same task doesn't wipe A's textarea mid-typing.

### Phase 4: Offline
Make the outbox persistent, add the retry/backoff, and add the status pill.
**Check**: In DevTools → Network → Offline: add 2 tasks and edit 1, and the pill shows `OFFLINE`. Reload while still offline, and the tasks are still there (from the cache plus the service worker after Phase 5). Go back online, and within about 5 s the pill shows `SYNCED` and the rows are in Supabase.

### Phase 5: PWA
Add the manifest, `sw.js`, icons and the head tags.
**Check**: Chrome DevTools → Application → Manifest shows no errors and the icons render. The Service Worker is "activated". Lighthouse "Installable" passes. With offline set, a reload still loads the app.

### Phase 6: Deploy + real-device test `[USER]` steps from §9
**Check**: Run the full checklist in §11 on the real PC and iPhone.

---

## 11. Two-device test checklist
- [ ] Add a task on PC → it appears on iPhone (app open) within ~2 s
- [ ] Add a task on iPhone → it appears on PC within ~2 s
- [ ] Write long notes on iPhone, close the app, open the PC → the notes are there
- [ ] Lock the iPhone for 10+ min, change things on PC, unlock and open the app → up to date within ~1 s
- [ ] Airplane mode on iPhone → add a task → turn airplane mode off → it reaches the PC
- [ ] Delete on PC → it disappears on iPhone. Undo on PC → it comes back on both
- [ ] Complete on iPhone → it moves to Done on PC
- [ ] The app opens instantly from the Home Screen icon, full-screen, with no Safari bars
- [ ] No horizontal scroll and nothing hidden under the notch or home bar
- [ ] The iPhone doesn't zoom in when tapping the input

---

## 12. Future ideas (after v1, one at a time)
1. Due dates plus a "Today" view
2. Lists or tags (e.g. Work / Home)
3. Drag to reorder (add a `position double precision` column)
4. Search (`/` then type to filter)
5. Light theme
6. Push reminders (Web Push works on iOS 16.4+ for Home Screen apps; it needs a Supabase Edge Function)
7. Markdown checkboxes inside notes

---

## 13. Known pitfalls (read before debugging)
| Symptom | Cause / fix |
|---|---|
| iPhone asks you to sign in again even though you're signed in in Safari | Home Screen apps have separate storage. Sign in once inside the installed app. |
| iPhone doesn't update after unlock | The socket died in the background. Rule 7 (`visibilitychange` → refresh + resubscribe) fixes this. |
| Realtime events never arrive | The table isn't in the publication. Rerun the `alter publication` line. Also check that the filter string is exactly `user_id=eq.<uuid>`. |
| `new row violates row-level security` | The user isn't signed in, or `user_id` was sent explicitly with a wrong value. Don't send `user_id`; let it default. |
| Old version keeps loading after deploy | `CACHE` in `sw.js` wasn't bumped. Bump it and push. Then close and reopen the app twice. |
| 404 for `app.js` on GitHub Pages | You used an absolute path (`/app.js`). Use relative paths. |
| Input zooms on iPhone | The input's font size is under 16px. |
| App is down / "project paused" | The Supabase free project went idle for 7+ days. Restore it in the dashboard. |
