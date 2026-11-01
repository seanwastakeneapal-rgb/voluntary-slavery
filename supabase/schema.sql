-- Voluntary Slavery schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run once on a fresh project.

-- ============ TABLES ============

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  emoji text not null default '🙂',
  color text not null default '#3355ff',
  onboarded boolean not null default false,
  last_seen_inbox timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text,
  target_date date,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  goal_id uuid references public.goals on delete set null,
  title text not null check (char_length(title) between 1 and 160),
  notes text,
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'done')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Friends rate a finished task 1-5. One vote per friend per task.
create table public.task_votes (
  task_id uuid not null references public.tasks on delete cascade,
  voter_id uuid not null default auth.uid() references public.profiles on delete cascade,
  points int not null check (points between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (task_id, voter_id)
);

-- Points given from one friend to another. Only written by donate_points().
create table public.donations (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.profiles on delete cascade,
  to_id uuid not null references public.profiles on delete cascade,
  amount int not null check (amount > 0),
  task_id uuid references public.tasks on delete set null,
  message text check (char_length(message) <= 140),
  created_at timestamptz not null default now(),
  check (from_id <> to_id)
);

-- Cheers on finished tasks, nudges on open ones.
create table public.reactions (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null default auth.uid() references public.profiles on delete cascade,
  task_id uuid not null references public.tasks on delete cascade,
  kind text not null check (kind in ('cheer', 'nudge')),
  emoji text not null default '👏',
  created_at timestamptz not null default now()
);

create index on public.tasks (owner_id);
create index on public.tasks (due_date);
create index on public.task_votes (task_id);
create index on public.reactions (task_id);

-- ============ TRIGGERS ============

-- New sign up gets a profile automatically (name from the email for now).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(split_part(new.email, '@', 1), 30));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The server stamps completed_at, so nobody can backdate a finish to fake a streak.
create function public.stamp_completed_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
  elsif new.status = 'todo' then
    new.completed_at := null;
  elsif tg_op = 'UPDATE' then
    new.completed_at := old.completed_at;
  end if;
  return new;
end $$;

create trigger tasks_stamp_completed
  before insert or update on public.tasks
  for each row execute function public.stamp_completed_at();

-- Changing a vote counts as a fresh inbox item.
create function public.touch_vote() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  return new;
end $$;

create trigger task_votes_touch
  before update on public.task_votes
  for each row execute function public.touch_vote();

-- ============ SCORING ============

-- A finished task is worth 1 point on its own.
-- Once friends vote, it's worth the rounded average of their votes.
create view public.task_scores with (security_invoker = true) as
select
  t.id as task_id,
  t.owner_id,
  t.completed_at,
  case when count(v.points) = 0 then 1 else round(avg(v.points))::int end as score,
  count(v.points)::int as vote_count
from public.tasks t
left join public.task_votes v on v.task_id = t.id
where t.status = 'done'
group by t.id;

create view public.leaderboard with (security_invoker = true) as
select
  p.id,
  p.display_name,
  p.emoji,
  p.color,
  coalesce(ts.pts_all, 0) + coalesce(rin.amt_all, 0) - coalesce(rout.amt_all, 0) as total,
  coalesce(ts.pts_week, 0) + coalesce(rin.amt_week, 0) - coalesce(rout.amt_week, 0) as week,
  coalesce(ts.done_all, 0) as tasks_done,
  coalesce(ts.done_week, 0) as tasks_week,
  coalesce(rin.amt_all, 0) as received,
  coalesce(rout.amt_all, 0) as given
from public.profiles p
left join (
  select owner_id,
    sum(score)::int as pts_all,
    (sum(score) filter (where completed_at > now() - interval '7 days'))::int as pts_week,
    count(*)::int as done_all,
    (count(*) filter (where completed_at > now() - interval '7 days'))::int as done_week
  from public.task_scores group by owner_id
) ts on ts.owner_id = p.id
left join (
  select to_id,
    sum(amount)::int as amt_all,
    (sum(amount) filter (where created_at > now() - interval '7 days'))::int as amt_week
  from public.donations group by to_id
) rin on rin.to_id = p.id
left join (
  select from_id,
    sum(amount)::int as amt_all,
    (sum(amount) filter (where created_at > now() - interval '7 days'))::int as amt_week
  from public.donations group by from_id
) rout on rout.from_id = p.id;

-- Give some of your own points to a friend. Checks you can afford it.
create function public.donate_points(
  p_to uuid,
  p_amount int,
  p_task uuid default null,
  p_message text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_balance int;
begin
  if v_me is null then raise exception 'Sign in first'; end if;
  if p_to = v_me then raise exception 'You can''t give points to yourself'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Give at least 1 point'; end if;

  -- One donation at a time per person, so two quick taps can't overspend.
  perform pg_advisory_xact_lock(hashtext(v_me::text));

  select total into v_balance from public.leaderboard where id = v_me;
  if coalesce(v_balance, 0) < p_amount then
    raise exception 'You only have % points to give', coalesce(v_balance, 0);
  end if;

  insert into public.donations (from_id, to_id, amount, task_id, message)
  values (v_me, p_to, p_amount, p_task, nullif(trim(p_message), ''));
end $$;

revoke execute on function public.donate_points(uuid, int, uuid, text) from public, anon;
grant execute on function public.donate_points(uuid, int, uuid, text) to authenticated;

-- ============ ROW LEVEL SECURITY ============
-- Everyone signed in can see the whole crew. You can only change your own stuff.

alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.tasks enable row level security;
alter table public.task_votes enable row level security;
alter table public.donations enable row level security;
alter table public.reactions enable row level security;

create policy "crew can read profiles" on public.profiles for select to authenticated using (true);
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "crew can read goals" on public.goals for select to authenticated using (true);
create policy "add own goals" on public.goals for insert to authenticated with check (owner_id = auth.uid());
create policy "edit own goals" on public.goals for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own goals" on public.goals for delete to authenticated using (owner_id = auth.uid());

create policy "crew can read tasks" on public.tasks for select to authenticated using (true);
create policy "add own tasks" on public.tasks for insert to authenticated with check (owner_id = auth.uid());
create policy "edit own tasks" on public.tasks for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own tasks" on public.tasks for delete to authenticated using (owner_id = auth.uid());

create policy "crew can read votes" on public.task_votes for select to authenticated using (true);
create policy "vote on friends' finished tasks" on public.task_votes for insert to authenticated
  with check (
    voter_id = auth.uid()
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.owner_id <> auth.uid() and t.status = 'done')
  );
create policy "change own vote" on public.task_votes for update to authenticated
  using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.owner_id <> auth.uid() and t.status = 'done')
  );
create policy "remove own vote" on public.task_votes for delete to authenticated using (voter_id = auth.uid());

create policy "crew can read donations" on public.donations for select to authenticated using (true);
-- No insert policy on purpose: donations only go in through donate_points().

create policy "crew can read reactions" on public.reactions for select to authenticated using (true);
create policy "react to friends' tasks" on public.reactions for insert to authenticated
  with check (
    from_id = auth.uid()
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.owner_id <> auth.uid()
                  and (kind = 'cheer' or t.status = 'todo'))
  );
create policy "remove own reactions" on public.reactions for delete to authenticated using (from_id = auth.uid());

-- ============ LIVE UPDATES ============

alter publication supabase_realtime add table
  public.profiles, public.goals, public.tasks, public.task_votes, public.donations, public.reactions;
