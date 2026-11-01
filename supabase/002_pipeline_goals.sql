-- Voluntary Slavery update 2: pipelines, measurable goals, "working on" line.
-- Run once in Supabase > SQL Editor, after schema.sql.

-- What each person is working on right now, shown on their profile.
alter table public.profiles add column mission text check (char_length(mission) <= 200);

-- Each person's own pipeline (e.g. Attention > Interest > ... > Referring client).
-- One stage at a time is the focus; stages get marked done once optimised.
create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  position int not null default 0,
  status text not null default 'todo' check (status in ('todo', 'focus', 'done')),
  created_at timestamptz not null default now()
);
create index on public.pipeline_stages (owner_id, position);
create unique index one_focus_per_person on public.pipeline_stages (owner_id) where status = 'focus';

-- Goals become measurable: a number, a unit, a start and a deadline (target_date).
alter table public.goals
  add column stage_id uuid references public.pipeline_stages on delete set null,
  add column metric_target numeric check (metric_target > 0),
  add column metric_unit text check (char_length(metric_unit) <= 30),
  add column start_date date not null default current_date;

alter table public.tasks add column stage_id uuid references public.pipeline_stages on delete set null;

-- Progress entries for a goal ("+5 outreaches"). Goal progress = sum of these.
create table public.goal_logs (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  amount numeric not null check (amount <> 0),
  note text check (char_length(note) <= 140),
  created_at timestamptz not null default now()
);
create index on public.goal_logs (goal_id);

alter table public.pipeline_stages enable row level security;
alter table public.goal_logs enable row level security;

create policy "chuds can read stages" on public.pipeline_stages for select to authenticated using (true);
create policy "add own stages" on public.pipeline_stages for insert to authenticated with check (owner_id = auth.uid());
create policy "edit own stages" on public.pipeline_stages for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own stages" on public.pipeline_stages for delete to authenticated using (owner_id = auth.uid());

create policy "chuds can read logs" on public.goal_logs for select to authenticated using (true);
create policy "log own goals" on public.goal_logs for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.goals g where g.id = goal_id and g.owner_id = auth.uid())
  );
create policy "delete own logs" on public.goal_logs for delete to authenticated using (owner_id = auth.uid());

alter publication supabase_realtime add table public.pipeline_stages, public.goal_logs;
