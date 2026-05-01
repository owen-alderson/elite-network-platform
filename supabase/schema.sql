-- Aether — Phase 1 schema
-- Apply once to a fresh Supabase project via the SQL editor.
-- This file is NOT idempotent — re-running on an existing schema will error
-- (intentional: we want loud failures, not silent skips).
--
-- Contracts upheld here:
--   * RLS is enabled on every public table.
--   * The anon key is safe to ship to the client because access is enforced
--     at the database level by these policies.
--   * Defensive triggers protect sensitive columns even if a policy is wrong.

create extension if not exists pgcrypto;

------------------------------------------------------------------------
-- Admin allowlist (phase 1 — hardcoded, single admin)
-- Mirrored in supabase.js (ADMIN_EMAILS). The DB copy is the real one.
------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- Accepts three classes of caller as admin:
  --   1. The postgres / service_role / supabase_admin db users (raw DB
  --      pathways like MCP execute_sql or direct connections).
  --   2. Service-role JWTs (edge functions using SUPABASE_SERVICE_ROLE_KEY).
  --   3. The hard-coded admin email allowlist (a member signed in as Owen).
  -- Without (1) and (2), defensive triggers silently revert legitimate
  -- privileged writes from the invite-member function and from MCP.
  select
    current_user in ('postgres', 'service_role', 'supabase_admin')
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or coalesce(lower(auth.jwt() ->> 'email'), '') = any(array[
      'owen.alderson@gmail.com'
    ]);
$$;

------------------------------------------------------------------------
-- Shared touch-updated-at trigger function
------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

------------------------------------------------------------------------
-- partner_spaces
-- Curated venues members can access (e.g. Spring Place NY). Admin-managed.
------------------------------------------------------------------------
create table public.partner_spaces (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text unique not null,
  city                text,
  country             text,
  description         text,
  address             text,
  subway_info         text,
  image_url           text,
  status              text not null default 'prospective'
                        check (status in ('confirmed','prospective','inactive')),
  is_founding_partner boolean not null default false,
  amenities           text[] not null default '{}',
  aether_connection   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index partner_spaces_status_idx on public.partner_spaces (status);

alter table public.partner_spaces enable row level security;

create policy "spaces_select_authed" on public.partner_spaces
  for select to authenticated using (true);

create policy "spaces_insert_admin" on public.partner_spaces
  for insert to authenticated with check (public.is_admin());

create policy "spaces_update_admin" on public.partner_spaces
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "spaces_delete_admin" on public.partner_spaces
  for delete to authenticated using (public.is_admin());

create trigger partner_spaces_touch_updated_at
before update on public.partner_spaces
for each row execute function public.touch_updated_at();

------------------------------------------------------------------------
-- members
-- Each row is keyed to an auth.users row (one-to-one, same id).
-- Created by an admin after an application is approved.
------------------------------------------------------------------------
create table public.members (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text unique not null,
  full_name          text not null,
  headline           text,
  bio                text,
  primary_pillar     text,
  secondary_pillars  text[] not null default '{}',
  location_city      text,
  location_country   text,
  linkedin_url       text,
  instagram_handle   text,
  website_url        text,
  avatar_url         text,
  achievements       jsonb not null default '[]',
  current_work       text,
  status             text not null default 'active'
                       check (status in ('active','paused','removed')),
  nominated_by       uuid references public.members(id),
  joined_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index members_primary_pillar_idx on public.members (primary_pillar);
create index members_status_idx on public.members (status);

alter table public.members enable row level security;

-- Read: any authenticated member sees other 'active' members; sees self regardless;
--       admins see everyone.
create policy "members_select_active_or_self_or_admin" on public.members
  for select to authenticated
  using (status = 'active' or id = auth.uid() or public.is_admin());

-- Insert: admin only (members are created post-approval).
create policy "members_insert_admin" on public.members
  for insert to authenticated with check (public.is_admin());

-- Update: members edit their own row; admins edit any.
create policy "members_update_self_or_admin" on public.members
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Delete: admin only.
create policy "members_delete_admin" on public.members
  for delete to authenticated using (public.is_admin());

-- Defence in depth: lock down columns that members must not be able to
-- self-mutate (status, nominated_by, primary key, immutable timestamps).
create or replace function public.members_protect_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_admin() then
    new.id := old.id;
    new.email := old.email;
    new.status := old.status;
    new.nominated_by := old.nominated_by;
    new.joined_at := old.joined_at;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger members_protect_columns
before update on public.members
for each row execute function public.members_protect_columns();

------------------------------------------------------------------------
-- applications
-- Public submission allowed (anon role can INSERT). Admin-only review.
------------------------------------------------------------------------
create table public.applications (
  id                       uuid primary key default gen_random_uuid(),
  submitted_at             timestamptz not null default now(),
  submission_type          text not null
                             check (submission_type in ('applicant','nominator')),
  applicant_full_name      text not null,
  applicant_email          text not null,
  applicant_pillar         text,
  applicant_headline       text,
  applicant_credential     text,
  applicant_achievements   jsonb not null default '[]',
  applicant_linkedin_url   text,
  applicant_website_url    text,
  applicant_location       text,
  applicant_current_work   text,
  nominator_member_id      uuid references public.members(id),
  nominator_full_name      text,
  nominator_email          text,
  nominator_note           text,
  status                   text not null default 'pending'
                             check (status in ('pending','approved','rejected','needs_more_info')),
  -- reviewed_by references auth.users (not members) so admins who do not
  -- yet have member rows can still review.
  reviewed_by              uuid references auth.users(id),
  reviewed_at              timestamptz,
  reviewer_notes           text,
  created_member_id        uuid references public.members(id)
);

create index applications_status_idx on public.applications (status);
create index applications_submitted_at_idx on public.applications (submitted_at desc);

alter table public.applications enable row level security;

-- Insert: anyone (anon or authed) can submit.
create policy "applications_insert_any" on public.applications
  for insert to anon, authenticated with check (true);

-- Read / update / delete: admin only.
create policy "applications_select_admin" on public.applications
  for select to authenticated using (public.is_admin());

create policy "applications_update_admin" on public.applications
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "applications_delete_admin" on public.applications
  for delete to authenticated using (public.is_admin());

-- Defence in depth: force review fields to defaults on non-admin INSERT.
-- Prevents a malicious anon client from POSTing { status: 'approved' }.
create or replace function public.applications_force_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.reviewer_notes := null;
    new.created_member_id := null;
  else
    -- non-admin UPDATE shouldn't pass RLS, but if a policy is ever loosened
    -- by mistake, this still preserves the protected columns.
    new.status := old.status;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    new.reviewer_notes := old.reviewer_notes;
    new.created_member_id := old.created_member_id;
  end if;
  return new;
end;
$$;

create trigger applications_force_defaults
before insert or update on public.applications
for each row execute function public.applications_force_defaults();

------------------------------------------------------------------------
-- intro_requests
-- Visibility (by design): requester, broker, admins. NOT the target —
-- targets find out via whatever notification channel the broker uses.
------------------------------------------------------------------------
create table public.intro_requests (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  requester_id  uuid not null references public.members(id) on delete cascade,
  target_id     uuid not null references public.members(id) on delete cascade,
  broker_id     uuid references public.members(id),
  note          text not null check (length(note) between 1 and 2000),
  status        text not null default 'pending'
                  check (status in ('pending','forwarded','accepted','declined','expired')),
  forwarded_at  timestamptz,
  responded_at  timestamptz,
  check (requester_id <> target_id)
);

create index intro_requests_requester_idx on public.intro_requests (requester_id);
create index intro_requests_broker_idx on public.intro_requests (broker_id);
create index intro_requests_status_idx on public.intro_requests (status);

alter table public.intro_requests enable row level security;

-- Insert: only as yourself.
create policy "intro_requests_insert_self" on public.intro_requests
  for insert to authenticated
  with check (requester_id = auth.uid());

-- Read: requester, broker, or admin.
create policy "intro_requests_select_party" on public.intro_requests
  for select to authenticated
  using (
    requester_id = auth.uid()
    or broker_id = auth.uid()
    or public.is_admin()
  );

-- Update: broker can change status; admins can do anything.
create policy "intro_requests_update_broker_or_admin" on public.intro_requests
  for update to authenticated
  using (broker_id = auth.uid() or public.is_admin())
  with check (broker_id = auth.uid() or public.is_admin());

-- Delete: admin only.
create policy "intro_requests_delete_admin" on public.intro_requests
  for delete to authenticated using (public.is_admin());

-- Defence in depth: a broker should change status only — not requester,
-- target, broker assignment, or note.
create or replace function public.intro_requests_protect_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_admin() then
    new.id := old.id;
    new.requester_id := old.requester_id;
    new.target_id := old.target_id;
    new.broker_id := old.broker_id;
    new.note := old.note;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger intro_requests_protect_columns
before update on public.intro_requests
for each row execute function public.intro_requests_protect_columns();

------------------------------------------------------------------------
-- events
-- Admin-curated; all members can read.
------------------------------------------------------------------------
create table public.events (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  created_by        uuid references public.members(id),
  title             text not null,
  description       text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  partner_space_id  uuid references public.partner_spaces(id),
  location_text     text,
  capacity          int check (capacity is null or capacity > 0),
  pillar_focus      text[] not null default '{}',
  visibility        text not null default 'all_members'
                      check (visibility in ('all_members','pillar_specific','invite_only')),
  status            text not null default 'upcoming'
                      check (status in ('upcoming','cancelled','past'))
);

create index events_starts_at_idx on public.events (starts_at);
create index events_status_idx on public.events (status);

alter table public.events enable row level security;

create policy "events_select_authed" on public.events
  for select to authenticated using (true);

create policy "events_insert_admin" on public.events
  for insert to authenticated with check (public.is_admin());

create policy "events_update_admin" on public.events
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "events_delete_admin" on public.events
  for delete to authenticated using (public.is_admin());

------------------------------------------------------------------------
-- event_rsvps
-- One row per (event, member). Members manage their own; admins all.
------------------------------------------------------------------------
create table public.event_rsvps (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  event_id    uuid not null references public.events(id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  status      text not null default 'going'
                check (status in ('going','maybe','declined')),
  unique (event_id, member_id)
);

create index event_rsvps_event_idx on public.event_rsvps (event_id);
create index event_rsvps_member_idx on public.event_rsvps (member_id);

alter table public.event_rsvps enable row level security;

-- Read: all authed members can see attendance (matches private-club norms
-- where members see who is going to what).
create policy "rsvps_select_authed" on public.event_rsvps
  for select to authenticated using (true);

-- Write: each member manages their own RSVP; admins can manage any.
create policy "rsvps_insert_self" on public.event_rsvps
  for insert to authenticated
  with check (member_id = auth.uid());

create policy "rsvps_update_self_or_admin" on public.event_rsvps
  for update to authenticated
  using (member_id = auth.uid() or public.is_admin())
  with check (member_id = auth.uid() or public.is_admin());

create policy "rsvps_delete_self_or_admin" on public.event_rsvps
  for delete to authenticated
  using (member_id = auth.uid() or public.is_admin());
