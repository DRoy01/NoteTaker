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
