-- v2: reorder, groups, colors, deadlines. Run in the Supabase SQL editor BEFORE deploying the v2 client.
alter table public.tasks add column if not exists position double precision;
alter table public.tasks add column if not exists grp      text not null default '' check (char_length(grp) <= 40);
alter table public.tasks add column if not exists color    text not null default '';
alter table public.tasks add column if not exists deadline date;
update public.tasks set position = -(extract(epoch from created_at) * 1000) where position is null;
alter table public.tasks alter column position set not null;
alter table public.tasks alter column position set default -(extract(epoch from now()) * 1000);
create index if not exists tasks_user_pos_idx on public.tasks (user_id, done, position);
