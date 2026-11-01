# To-Do v2 — Reorder, Groups/Colors/Deadlines, Views

Builds on `PLAN.md` (v1 is live). All v1 rules still apply: no framework, no build step, relative paths, `textContent` only (never `innerHTML` for user text), design tokens from `PLAN.md` §5, `db.js` is the only file that touches Supabase.

## 1. Features
| # | Feature |
|---|---|
| V1 | **Drag to reorder** Open tasks (mouse and touch). The order is manual and syncs across devices. |
| V2 | **Detail panel fields**: group (free text with suggestions), label color (8 presets), deadline (date). |
| V3 | **Highly visible deadlines**: glowing red when overdue or due today, amber when soon, muted otherwise. Shown on the row and in the panel. |
| V4 | **Browse views**: All · Groups · Deadlines. Groups view filters by group. Deadlines view sorts by date and has quick filters plus a custom date range. |

Out of scope: reminders/notifications, times (date only), nested groups, renaming a group everywhere in one click.

## 2. Data contract (single source of truth — all agents obey this)

Task shape adds four fields:
```js
{ id, title, notes, done, created_at, updated_at, completed_at,
  position,   // number (double). Lower = higher in the list. Manual order.
  grp,        // string, '' = ungrouped. Max 40 chars, trimmed. (Column is `grp` because `group` is a SQL keyword.)
  color,      // string key, one of COLORS below, '' = none
  deadline }  // 'YYYY-MM-DD' string (local calendar date) or null
```

`COLORS` (exported from `store.js`): `{ red:'#f2637e', amber:'#f2a93b', green:'#4cc38a', teal:'#2dd4bf', blue:'#6f8fff', purple:'#a78bfa', pink:'#f472b6', gray:'#96a0b2' }`. Keys are stored, hex values are used only for display.

### Position rules (fractional ordering)
- New task: `position = (min position of all tasks) - 1`, or `-Date.now()` if there are none. It lands on top.
- Migration backfills `position = -(epoch ms of created_at)`, so the existing order (newest first) is kept.
- Move to between neighbors A and B: `(A.position + B.position) / 2`. To the top: `first - 1`. To the bottom: `last + 1`. Neighbors are taken from the **list currently shown** (after filters), which still gives a valid global order.
- If two positions are closer than `1e-6`, renumber all Open tasks `0, 1, 2, …` in current order in one batch (one `upsert` per changed task).
- Sorting everywhere: `position asc`, ties broken by `created_at desc`.
- Tasks loaded without `position` (old local cache) get `-Date.parse(created_at)` at load.

### Deadline status helper (exported from `store.js`)
`deadlineInfo(deadline, today = localTodayString())` → `null` or `{ days, level, label }`
- `days` = whole calendar days from today to the deadline (negative = overdue).
- `level`: `'overdue'` (days < 0), `'today'` (0), `'soon'` (1–3), `'later'` (>3).
- `label`: `'OVERDUE 2D'`, `'TODAY'`, `'TOMORROW'`, `'IN 3D'`, or a short date like `'12 NOV'`.
- Done tasks never show urgent levels (UI treats them as `'later'`).
- Use the **local** date, never `toISOString().slice(0,10)`, which is UTC and gives the wrong day.

### Store API additions (in `store.js`)
```js
export const COLORS, deadlineInfo, localTodayString
export function moveTask(id, beforeId, afterId)  // either neighbor may be null; computes position, may renumber
export function getGroups()                      // → [{ name, open }] sorted by name, excluding ''
export function query({ view, group, sort, from, to })  // → Task[] of OPEN tasks, see §4
// updateTask(id, patch) already accepts grp / color / deadline in patch
```
`addTask(title, notes='')` keeps its signature. The new fields get defaults (`grp:''`, `color:''`, `deadline:null`, position per rules).

### Backend (`supabase/migration-v2.sql`, additive and safe for the old client)
```sql
alter table public.tasks add column if not exists position double precision;
alter table public.tasks add column if not exists grp      text not null default '' check (char_length(grp) <= 40);
alter table public.tasks add column if not exists color    text not null default '';
alter table public.tasks add column if not exists deadline date;
update public.tasks set position = -(extract(epoch from created_at) * 1000) where position is null;
alter table public.tasks alter column position set not null;
alter table public.tasks alter column position set default -(extract(epoch from now()) * 1000);
create index if not exists tasks_user_pos_idx on public.tasks (user_id, done, position);
```
`schema.sql` is also updated so a fresh install gets the same columns. `db.js` `COLS` adds `position,grp,color,deadline`.

> **Order matters:** the migration must be run in Supabase **before** the new client is deployed. The sync code drops ops on non-network errors, so new columns hitting an un-migrated table would silently lose edits.

## 3. UI spec

### 3.1 Detail panel (below Notes, above the meta line)
```
 GROUP      [ Work                 ▾ ]     ← <input list="groups-list"> + <datalist> of existing groups
 COLOR      ● ● ● ● ● ● ● ● ⊘             ← 8 swatches + "none"; selected has a 2px --text ring
 DEADLINE   [ 2026-11-12 ]  [ CLEAR ]     ← <input type="date">; chip below shows the urgency label
```
- Group, color and deadline save immediately on change. The title and notes keep the 600 ms debounce.
- Don't clobber a focused field when a remote update arrives (v1 rule 6).

### 3.2 Task row
`[checkbox] Title  [GROUP chip] [DEADLINE chip] ¶`
- A 4px left stripe in the task's color (if any), drawn with `box-shadow: inset 4px 0 0 <hex>` so the layout doesn't shift.
- The group chip is mono 11px uppercase, `--muted` on `--surface-2`.
- Deadline chip by level, always mono 11px bold uppercase, padding `2px 8px`, radius 6px:
  - `overdue`: background `#ff2d55`, white text, **glow** `box-shadow: 0 0 0 1px #ff2d55, 0 0 12px 2px rgba(255,45,85,.75)`, slow pulse animation (1.6s, opacity/shadow only). Add the text `OVERDUE Nd`.
  - `today`: same red, solid with glow but no pulse. Text `TODAY`.
  - `soon`: `--amber` outline and text, no glow.
  - `later`: `--muted` text, no border.
- Under `prefers-reduced-motion`, keep the glow but drop the pulse.
- Contrast must be at least 4.5:1 for the chip text. White on `#ff2d55` passes for bold 11px. Verify it.
- In the panel, the same chip is shown larger (13px).

### 3.3 Views bar (under the Open/Done tabs; applies to the Open tab only)
```
 VIEW   ALL · GROUPS · DEADLINES
 (Groups)     [ ALL 12 ] [ WORK 5 ] [ HOME 3 ] [ UNGROUPED 4 ]          ← chips with counts
 (Deadlines)  SORT: SOONEST | LATEST      FILTER: ALL · OVERDUE · TODAY · THIS WEEK · CUSTOM
              CUSTOM → two <input type="date"> (from, to), either may be empty
```
- **All**: manual order (drag enabled).
- **Groups**: manual order within the chosen group (drag enabled).
- **Deadlines**: sorted by deadline (ties by position), tasks with no deadline are shown last under a "NO DEADLINE" divider. Drag is **disabled** here and the cursor is the default.
- Filter semantics for `query()`: `OVERDUE` = deadline < today; `TODAY` = deadline = today; `THIS WEEK` = today ≤ deadline ≤ today+6; `CUSTOM` = from ≤ deadline ≤ to (empty bound = open-ended); with any deadline filter active, tasks without a deadline are hidden.
- The Done tab ignores the views bar (hide the bar there).
- The selected view, group, sort, filter and custom dates persist in `localStorage` key `todo.view.v1` (try/catch). If a saved group no longer exists, fall back to ALL.
- The header count stays "TASKS · n OPEN" (total, not filtered). Show a small `SHOWING k` mono label next to the views bar when a filter is active.
- Empty filter result (Caveat): *"Nothing matches."*

### 3.4 Drag and drop (`drag.js`, a new module)
```js
export function enableDrag(listEl, { onMove, canDrag })
// onMove(id, beforeId, afterId): called once on drop with the new neighbors (null at the ends)
// canDrag(): returns false to disable (Done tab, Deadlines view)
```
- Use **Pointer Events** (not the HTML5 drag API, which doesn't work on iOS). Dragging starts from a visible **grip handle** (⋮⋮, 44×44px hit area) at the row's far right, with `touch-action: none` on the handle only, so the page still scrolls normally elsewhere.
- While dragging: the row lifts (a scale 1.02 and shadow), a thin amber insertion line shows the drop spot, and the list auto-scrolls near the top and bottom edges.
- On drop, call `onMove` once and let the normal render rebuild the list. Escape or a cancelled pointer restores the original order.
- No library. Under 150 lines. Set the handle `aria-label="Drag to reorder"`. Also add keyboard reordering: with the handle focused, Alt+↑ and Alt+↓ move the task by one place, calling `onMove`.
- Styles for drag live in `drag.css` (linked from `index.html`).

## 4. `query()` contract
```js
query({ view: 'all'|'groups'|'deadlines',
        group: null|string,        // groups view: null = all, '' = ungrouped, else the name
        sort: 'asc'|'desc',        // deadlines view
        filter: 'all'|'overdue'|'today'|'week'|'custom',
        from: 'YYYY-MM-DD'|'', to: 'YYYY-MM-DD'|'' })
```
Returns open tasks only. For `all`/`groups`, sorted by manual order. For `deadlines`, sorted by deadline (`asc`/`desc`), no-deadline tasks last, ties by position.

## 5. File ownership (agents must not edit files outside their own list)
| Agent | Owns | Must not touch |
|---|---|---|
| **A: data** | `store.js`, `db.js`, `supabase/schema.sql`, `supabase/migration-v2.sql` | UI files |
| **B: UI** | `index.html`, `styles.css`, `app.js` | `store.js`, `db.js`, `drag.js` |
| **C: drag** | `drag.js`, `drag.css` | everything else |

Integration points agree on the contracts above: A exports the §2/§4 API, C exports `enableDrag`, and B imports both. B calls `enableDrag($('task-list'), { onMove: store.moveTask, canDrag })` once at startup, and the rows need `data-id` plus a `.grip` handle element that B creates in `rowEl`. After the agents finish, the lead agent bumps `CACHE` to `todo-v2` in `sw.js`, adds `drag.js`, `drag.css` to `SHELL`, and runs the checks in §6.

## 6. Acceptance checks
**Data (A)**: a Node smoke test (stub `localStorage`) shows: new tasks land on top; `moveTask` yields the right order between neighbors, to top and to bottom; renumbering triggers on collision and keeps order; `deadlineInfo` returns the right level around today, tomorrow, overdue and a 4-day gap; `query` returns the right sets for every filter; an old cached task without the new fields loads with defaults.
**UI (B)**: at 375px and 1280px: the fields save and sync; chips and stripes render; the views bar behaves per §3.3; the glow is visible and legible on the dark background; the layout has no horizontal scroll; user text is never inserted with `innerHTML`.
**Drag (C)**: a headless-browser test or, failing that, a documented manual test: mouse drag, touch drag (emulated), Escape cancel, edge auto-scroll, and Alt+Arrow.
**Whole**: the two-device checklist from `PLAN.md` §11, plus: drag on the PC and the order changes on the iPhone; a deadline set on the iPhone glows on the PC.

## 7. Release steps
1. `[USER]` Run `supabase/migration-v2.sql` in the Supabase SQL editor.
2. Lead: bump `CACHE`, update `README.md`, commit, push. GitHub Pages redeploys in about a minute.
3. Close and reopen the installed apps twice to pick up the new service worker.
