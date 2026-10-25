-- =====================================================================
-- AGYEMAN: setup completo del database (Supabase / PostgreSQL)
-- Unica modifica richiesta: la tua email alla riga indicata qui sotto.
-- =====================================================================

create table if not exists public.app_config (id int primary key default 1, owner_email text not null);
insert into public.app_config (id, owner_email)
values (1, 'TUA_EMAIL@ESEMPIO.IT')          -- <<< SOSTITUISCI CON LA TUA EMAIL DI ACCESSO
on conflict (id) do update set owner_email = excluded.owner_email;
alter table public.app_config enable row level security;

-- vero solo per l'utente proprietario
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((auth.jwt() ->> 'email') = (select owner_email from public.app_config where id = 1), false)
$$;

-- ---------------- Garmin ----------------
create table if not exists public.daily (
  day date primary key,
  hrv_night numeric, hrv_weekly numeric, hrv_status text, resting_hr numeric,
  sleep_seconds integer, deep_seconds integer, light_seconds integer, rem_seconds integer, awake_seconds integer,
  sleep_score integer, sleep_start timestamptz, sleep_end timestamptz,
  body_battery_max integer, body_battery_min integer, stress_avg integer, steps integer,
  active_kcal integer, total_kcal integer, bmr_kcal integer, training_readiness integer,
  raw jsonb, updated_at timestamptz default now()
);
create table if not exists public.activities (
  id bigint primary key, start_local timestamp, type_key text, name text,
  duration_s numeric, avg_hr numeric, max_hr numeric, kcal numeric,
  training_load numeric, aerobic_te numeric, anaerobic_te numeric,
  distance_m numeric, avg_speed numeric, max_speed numeric, avg_cadence numeric, elev_gain numeric,
  avg_power numeric, vo2max numeric, te_label text, hr_zones jsonb, splits jsonb,
  raw jsonb, updated_at timestamptz default now()
);
create table if not exists public.metrics (
  day date primary key, vo2max_run numeric, vo2max_cycling numeric, training_status text,
  acute_load numeric, chronic_load numeric, load_ratio numeric,
  race_5k_s integer, race_10k_s integer, race_half_s integer, race_marathon_s integer,
  raw jsonb, updated_at timestamptz default now()
);
create table if not exists public.records (
  type_id integer primary key, label text, value numeric, activity_id bigint, achieved_at text,
  raw jsonb, updated_at timestamptz default now()
);

-- ---------------- Corpo: composizione, analisi, piano alimentare ----------------
create table if not exists public.body_comp (
  day date not null, src text not null default 'Garmin',      -- Garmin, Manuale, bioimpedenza, DEXA...
  weight_kg numeric, fat_pct numeric, muscle_kg numeric, bone_kg numeric, water_pct numeric, bmi numeric,
  raw jsonb, updated_at timestamptz default now(), primary key (day, src)
);
create table if not exists public.labs (
  id uuid primary key default gen_random_uuid(), date date not null, lab text,
  items jsonb not null,                                          -- [{name, value, unit, low, high, ref, text}]
  created_at timestamptz default now()
);
create table if not exists public.diet_plans (
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), plan jsonb not null
);
create table if not exists public.training_plans (                -- schede del trainer (trascritte)
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), plan jsonb not null
);

-- ---------------- Pasti e coach ----------------
create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(), eaten_at timestamptz default now(), day date not null,
  meal_type text, title text, items jsonb, kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, fiber_g numeric,
  confidence text, notes text, thumb text
);
create table if not exists public.chat_messages (
  id bigserial primary key, created_at timestamptz default now(),
  role text not null check (role in ('user', 'assistant')), content text not null
);

-- ---------------- Assistente: Outlook, agenda, task, bollette ----------------
create table if not exists public.ms_tokens (id int primary key default 1, refresh_token text not null, updated_at timestamptz default now());
create table if not exists public.ms_oauth_state (state text primary key, created_at timestamptz default now());
create table if not exists public.emails (
  id text primary key, received_at timestamptz, from_name text, from_addr text, subject text, preview text,
  prio text, summary text, actions jsonb, triaged_at timestamptz default now()
);
create table if not exists public.events (
  id text primary key, start_at timestamptz, end_at timestamptz, subject text, location text,
  all_day boolean default false, area text default 'work', src text default 'Outlook'
);
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(), title text not null, due date, remind_at timestamptz,
  done boolean default false, area text default 'life', src text default 'Agyeman',
  email_id text, ms_todo_id text, created_at timestamptz default now()
);
create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(), vendor text, amount numeric, due date,
  status text default 'da pagare', notice_code text, ente_cf text, method text, code text,
  email_id text unique, src text default 'Email', created_at timestamptz default now()
);

-- ---------------- Sicurezza (RLS) ----------------
do $$
declare t text;
begin
  foreach t in array array['daily','activities','metrics','records','meals','chat_messages','ms_tokens','ms_oauth_state','emails','events','tasks','bills','body_comp','labs','diet_plans','training_plans'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- lettura per il proprietario
  foreach t in array array['daily','activities','metrics','records','emails'] loop
    execute format('drop policy if exists owner_read on public.%I', t);
    execute format('create policy owner_read on public.%I for select to authenticated using (public.is_owner())', t);
  end loop;
  -- lettura e scrittura per il proprietario
  foreach t in array array['meals','chat_messages','events','tasks','bills','body_comp','labs','diet_plans','training_plans'] loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;
-- le azioni suggerite dalle email possono essere segnate come fatte dall'app
drop policy if exists owner_update on public.emails;
create policy owner_update on public.emails for update to authenticated using (public.is_owner()) with check (public.is_owner());
-- ms_tokens, ms_oauth_state e app_config: nessuna policy, accessibili solo alle funzioni server.
