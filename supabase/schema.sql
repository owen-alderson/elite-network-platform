-- Aether — Phase 1 schema (canonical)
-- Reflects every migration applied through 2026-05-01. This file is
-- non-idempotent on a fresh project — run as a single shot via the
-- Supabase SQL editor or apply piece-by-piece via mcp__supabase__apply_migration.
--
-- Contracts upheld here:
--   * RLS is enabled on every public table.
--   * The publishable (anon) key is safe to ship to the client because
--     access is enforced at the database level by these policies.
--   * Defensive triggers protect sensitive columns even if a policy is wrong.

create extension if not exists pgcrypto;
create extension if not exists pg_net   with schema extensions;
create extension if not exists pg_cron  with schema extensions;

------------------------------------------------------------------------
-- Admin allowlist (phase 1 — sole admin: Owen)
-- Mirrored in supabase.js (ADMIN_EMAILS). The DB copy is the real one.
------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- Three classes of admin caller:
  --   1. The postgres / service_role / supabase_admin db users (raw DB
  --      pathways like MCP execute_sql or direct connections).
  --   2. Service-role JWTs (edge functions using SUPABASE_SERVICE_ROLE_KEY).
  --   3. The hard-coded admin email allowlist.
  -- (1) and (2) are critical — without them, defensive triggers below
  -- silently revert legitimate privileged writes from edge functions.
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

-- Public read: spaces.html is a marketing surface visible to anonymous
-- visitors. Anyone can read; only admin can write.
create policy "spaces_select_public" on public.partner_spaces
  for select to anon, authenticated using (true);

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
-- Created post-approval via the invite-member edge function.
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
  last_seen_at       timestamptz not null default now(),
  -- Free-form tags, capped at 5. Supplements the single primary pillar.
  -- Per Owen's 2026-05-02 model: 1 pillar + 1 city + up to 5 tags.
  tags               text[] not null default '{}'
                       check (cardinality(tags) <= 5),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index members_primary_pillar_idx on public.members (primary_pillar);
create index members_status_idx on public.members (status);
create index members_last_seen_idx on public.members (last_seen_at);
create index members_tags_idx on public.members using gin (tags);

alter table public.members enable row level security;

create policy "members_select_active_or_self_or_admin" on public.members
  for select to authenticated
  using (status = 'active' or id = auth.uid() or public.is_admin());

create policy "members_insert_admin" on public.members
  for insert to authenticated with check (public.is_admin());

create policy "members_update_self_or_admin" on public.members
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy "members_delete_admin" on public.members
  for delete to authenticated using (public.is_admin());

-- Defence in depth: lock down columns members must not self-mutate.
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
    -- primary_pillar self-editable in pilot (Owen 2026-05-02). Later
    -- phases may gate this behind admin approval. Tags and
    -- secondary_pillars also stay self-editable.
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
  -- Headlining application question — YC-style "describe something
  -- impressive you've built or done." Primary selection signal. Required
  -- for applicant submissions; min 100 chars enforced at the form layer.
  applicant_signature_achievement text,
  applicant_achievements   jsonb not null default '[]',
  -- Free-form tags, capped at 5. Supplements the single primary pillar.
  applicant_tags           text[] not null default '{}'
                             check (cardinality(applicant_tags) <= 5),
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
  reviewed_by              uuid references auth.users(id),
  reviewed_at              timestamptz,
  reviewer_notes           text,
  created_member_id        uuid references public.members(id),
  -- Stamps for the two transactional emails associated with this row:
  --   confirmation_sent_at:    send-application-confirmation (after submit;
  --                            for nominator submissions this stamps the
  --                            nominator confirmation email specifically)
  --   status_email_sent_at:    send-application-status (after rejected /
  --                            needs_more_info)
  --   nominee_invite_sent_at:  the second email fired on a nominator INSERT —
  --                            invites the nominee to complete their applicant
  --                            submission via apply.html?code=<>&email=<>
  confirmation_sent_at     timestamptz,
  status_email_sent_at     timestamptz,
  nominee_invite_sent_at   timestamptz,
  -- Two-stage Option-A nomination linkage. nomination_code is generated
  -- client-side at nominator submit time (32^8 ≈ 1.1 trillion space, no
  -- ambiguous chars). The nominee's later applicant submission carries the
  -- same code, allowing admin to pair the records. applications_validate_
  -- nomination_pair() trigger requires (code, applicant_email) to match a
  -- pending nomination row before allowing the applicant insert.
  nomination_code          text
);

create index applications_status_idx on public.applications (status);
create index applications_submitted_at_idx on public.applications (submitted_at desc);

-- Block multiple pending / needs_more_info applications for the same
-- (email, submission_type) pair. Scoping by submission_type allows a
-- pending nomination AND a pending applicant for the same email to
-- coexist (parent + child rows in the Option-A two-stage flow). Once
-- an application is closed (rejected, approved), a fresh attempt is allowed.
create unique index if not exists applications_unique_open_email
  on public.applications (lower(applicant_email), submission_type)
  where status in ('pending', 'needs_more_info');

-- Unique index on nomination_code where present — collision protection
-- for the 8-char codes generated at nominator submit time.
create unique index if not exists applications_nomination_code_unique
  on public.applications (nomination_code)
  where nomination_code is not null;

alter table public.applications enable row level security;

create policy "applications_insert_any" on public.applications
  for insert to anon, authenticated with check (true);

create policy "applications_select_admin" on public.applications
  for select to authenticated using (public.is_admin());

create policy "applications_update_admin" on public.applications
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "applications_delete_admin" on public.applications
  for delete to authenticated using (public.is_admin());

-- Force review fields to defaults on non-admin INSERT/UPDATE.
-- Also locks the email-stamp columns and nomination_code on UPDATE so a
-- non-admin can't (a) spoof "already sent" timestamps to silently block
-- the email pipeline, (b) mutate a nomination_code post-insert.
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
    new.confirmation_sent_at := null;
    new.status_email_sent_at := null;
    new.nominee_invite_sent_at := null;
    -- nomination_code is settable on INSERT (generated client-side by apply.js).
  else
    new.status := old.status;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    new.reviewer_notes := old.reviewer_notes;
    new.created_member_id := old.created_member_id;
    new.confirmation_sent_at := old.confirmation_sent_at;
    new.status_email_sent_at := old.status_email_sent_at;
    new.nominee_invite_sent_at := old.nominee_invite_sent_at;
    new.nomination_code := old.nomination_code;
  end if;
  return new;
end;
$$;

create trigger applications_force_defaults
before insert or update on public.applications
for each row execute function public.applications_force_defaults();

-- Auth gate: nominator submissions require nominator_member_id to equal
-- auth.uid() (matches the JS client's session.user.id). Defends against
-- direct API calls bypassing the apply.html JS auth check. Admin/service-
-- role bypass for legitimate backfill / test seeds.
create or replace function public.applications_validate_nominator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.submission_type = 'nominator' and not public.is_admin() then
    if new.nominator_member_id is null or new.nominator_member_id <> auth.uid() then
      raise exception 'Nominations require an authenticated member as nominator_member_id (must equal auth.uid())';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists applications_validate_nominator on public.applications;
create trigger applications_validate_nominator
before insert on public.applications
for each row execute function public.applications_validate_nominator();

-- Pair validation: an applicant submission carrying a nomination_code must
-- (a) reference a real pending nomination row and (b) use the same email
-- the nomination was issued for. Without this trigger, an attacker who
-- learned a code (e.g. forwarded invite email) could submit an applicant
-- row with their own email + the stolen code — and admin would see what
-- looked like a paired record.
create or replace function public.applications_validate_nomination_pair()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_email text;
begin
  if new.submission_type = 'applicant' and new.nomination_code is not null and not public.is_admin() then
    select lower(applicant_email) into parent_email
    from public.applications
    where nomination_code = new.nomination_code
      and submission_type = 'nominator'
      and status in ('pending', 'needs_more_info')
    limit 1;
    if parent_email is null then
      raise exception 'Invalid or expired nomination code';
    end if;
    if parent_email <> lower(new.applicant_email) then
      raise exception 'Email does not match the nominated address';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists applications_validate_nomination_pair on public.applications;
create trigger applications_validate_nomination_pair
before insert on public.applications
for each row execute function public.applications_validate_nomination_pair();

-- Email triggers (call edge functions via pg_net):
--   on INSERT  → send-application-confirmation
--   on UPDATE  → send-application-status when status flips to
--                rejected / needs_more_info (approve uses invite-member instead)
create or replace function public.applications_send_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://emlresxklixzcsammste.supabase.co/functions/v1/send-application-confirmation',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('application_id', new.id)
  );
  return new;
end;
$$;

create trigger applications_send_confirmation
after insert on public.applications
for each row execute function public.applications_send_confirmation();

create or replace function public.applications_send_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
     and new.status in ('rejected', 'needs_more_info') then
    perform net.http_post(
      url := 'https://emlresxklixzcsammste.supabase.co/functions/v1/send-application-status',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('application_id', new.id)
    );
  end if;
  return new;
end;
$$;

create trigger applications_send_status_change
after update on public.applications
for each row execute function public.applications_send_status_change();

------------------------------------------------------------------------
-- intro_requests
-- The core mechanic. Two route variants:
--   route='broker' — requested when a mutual connection exists; admin
--                    assigns a broker; broker forwards off-platform.
--   route='direct' — no mutual connection; goes straight to target,
--                    target accepts/declines themselves. Capped at 5
--                    pending per requester.
-- A connection forms (and unlocks DM) when status = 'accepted'.
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
  route         text not null default 'broker'
                  check (route in ('broker','direct')),
  forwarded_at  timestamptz,
  responded_at  timestamptz,
  check (requester_id <> target_id)
);

create index intro_requests_requester_idx on public.intro_requests (requester_id);
create index intro_requests_broker_idx    on public.intro_requests (broker_id);
create index intro_requests_target_idx    on public.intro_requests (target_id);
create index intro_requests_status_idx    on public.intro_requests (status);
create index intro_requests_route_idx     on public.intro_requests (route);

-- Block duplicate pending requests from the same requester to the same
-- target. Resolves once the previous one closes.
create unique index if not exists intro_requests_unique_pending_pair
  on public.intro_requests (requester_id, target_id)
  where status = 'pending';

alter table public.intro_requests enable row level security;

create policy "intro_requests_insert_self" on public.intro_requests
  for insert to authenticated
  with check (requester_id = auth.uid());

-- SELECT: requester always; broker if assigned; target only on direct route; admin always.
create policy "intro_requests_select_party" on public.intro_requests
  for select to authenticated
  using (
    requester_id = auth.uid()
    or broker_id = auth.uid()
    or (target_id = auth.uid() and route = 'direct')
    or public.is_admin()
  );

-- UPDATE: same visibility set; protect_columns trigger locks immutables.
create policy "intro_requests_update_party_or_admin" on public.intro_requests
  for update to authenticated
  using (
    broker_id = auth.uid()
    or requester_id = auth.uid()
    or (target_id = auth.uid() and route = 'direct')
    or public.is_admin()
  )
  with check (
    broker_id = auth.uid()
    or requester_id = auth.uid()
    or (target_id = auth.uid() and route = 'direct')
    or public.is_admin()
  );

create policy "intro_requests_delete_admin" on public.intro_requests
  for delete to authenticated using (public.is_admin());

-- Defence in depth: a non-admin can only change status / forwarded_at /
-- responded_at. All other columns (parties, note, route, created_at)
-- are immutable post-insert.
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
    new.route := old.route;
  end if;
  return new;
end;
$$;

create trigger intro_requests_protect_columns
before update on public.intro_requests
for each row execute function public.intro_requests_protect_columns();

-- Connection helpers (used by routing trigger + conversations RLS).
create or replace function public.are_connected(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.intro_requests
    where status = 'accepted'
      and (
        (requester_id = a and target_id = b)
        or (requester_id = b and target_id = a)
      )
  );
$$;

create or replace function public.has_mutual_connection(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  with a_conns as (
    select case when requester_id = a then target_id else requester_id end as other
    from public.intro_requests
    where status = 'accepted'
      and (requester_id = a or target_id = a)
  ),
  b_conns as (
    select case when requester_id = b then target_id else requester_id end as other
    from public.intro_requests
    where status = 'accepted'
      and (requester_id = b or target_id = b)
  )
  select exists (select 1 from a_conns intersect select 1 from b_conns);
$$;

-- Returns the set of member IDs connected to BOTH a and b. Used by the
-- admin broker picker so only valid brokers appear.
create or replace function public.mutual_connections(a uuid, b uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  with a_conns as (
    select case when requester_id = a then target_id else requester_id end as other
    from public.intro_requests
    where status = 'accepted'
      and (requester_id = a or target_id = a)
  ),
  b_conns as (
    select case when requester_id = b then target_id else requester_id end as other
    from public.intro_requests
    where status = 'accepted'
      and (requester_id = b or target_id = b)
  )
  select other from a_conns intersect select other from b_conns;
$$;

revoke execute on function public.mutual_connections(uuid, uuid) from public;
grant  execute on function public.mutual_connections(uuid, uuid) to authenticated;

-- Combined routing + rate-limit trigger.
--
-- These two operations were previously split across two BEFORE INSERT
-- triggers (set_route + check_direct_limit). Postgres fires BEFORE
-- triggers in alphabetical order, which put check_direct_limit BEFORE
-- set_route, so the limit check read the column default ('broker') for
-- new.route and never fired the direct-only branch. The 5-pending cap
-- was bypassable. Combining them into one function guarantees the
-- right order in one body.
create or replace function public.intro_requests_route_and_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pending_count int;
begin
  -- 1. Decide route based on whether requester + target share a mutual.
  if public.has_mutual_connection(new.requester_id, new.target_id) then
    new.route := 'broker';
  else
    new.route := 'direct';
  end if;

  -- 2. Now that route is set, enforce the 5-pending-direct cap.
  if new.route = 'direct' and new.status = 'pending' then
    select count(*) into pending_count
    from public.intro_requests
    where requester_id = new.requester_id
      and route = 'direct'
      and status = 'pending';
    if pending_count >= 5 then
      raise exception 'You have 5 pending direct intro requests already. Wait for responses or cancel some.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger intro_requests_route_and_limit
before insert on public.intro_requests
for each row execute function public.intro_requests_route_and_limit();

-- Notification triggers: fire send-intro-notification edge function on
-- the four state transitions worth emailing about.
create or replace function public.intro_requests_notify_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fn_url text := 'https://emlresxklixzcsammste.supabase.co/functions/v1/send-intro-notification';
begin
  if new.route = 'direct' and new.status = 'pending' then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('intro_id', new.id, 'event', 'direct_received')
    );
  end if;
  return new;
end;
$$;

create trigger intro_requests_notify_insert
after insert on public.intro_requests
for each row execute function public.intro_requests_notify_insert();

create or replace function public.intro_requests_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fn_url text := 'https://emlresxklixzcsammste.supabase.co/functions/v1/send-intro-notification';
begin
  if (old.broker_id is null and new.broker_id is not null and new.status = 'pending') then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('intro_id', new.id, 'event', 'broker_assigned')
    );
  end if;

  if (old.status is distinct from new.status and new.status = 'forwarded') then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('intro_id', new.id, 'event', 'forwarded')
    );
  end if;

  if (old.status is distinct from new.status and new.status = 'accepted' and new.route = 'direct') then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('intro_id', new.id, 'event', 'direct_accepted')
    );
  end if;

  return new;
end;
$$;

create trigger intro_requests_notify
after update on public.intro_requests
for each row execute function public.intro_requests_notify();

-- Spawn a conversation when an intro hits 'accepted' (either route).
-- Seeds the conversation with the requester's note as the first message.
create or replace function public.intro_requests_open_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a uuid;
  b uuid;
  conv_id uuid;
begin
  if old.status = new.status or new.status <> 'accepted' then
    return new;
  end if;

  a := least(new.requester_id, new.target_id);
  b := greatest(new.requester_id, new.target_id);

  insert into public.conversations (member_a, member_b, intro_id)
  values (a, b, new.id)
  on conflict (member_a, member_b) do update set intro_id = excluded.intro_id
  returning id into conv_id;

  if conv_id is not null and new.note is not null then
    insert into public.messages (conversation_id, sender_id, body)
    values (conv_id, new.requester_id, new.note);
  end if;

  return new;
end;
$$;

create trigger intro_requests_open_conversation
after update on public.intro_requests
for each row execute function public.intro_requests_open_conversation();

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
  -- Optional admin-uploaded event image. If null, the runtime renderers
  -- fall back to partner_spaces.image_url for the linked space.
  image_url         text,
  -- "What to expect" cards on the public event page. Array of
  -- { title, body }. Empty → section hidden.
  expectations      jsonb not null default '[]'::jsonb,
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

create policy "rsvps_select_authed" on public.event_rsvps
  for select to authenticated using (true);

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

------------------------------------------------------------------------
-- conversations + messages
-- Connection-gated 1:1 DM. Conversation rows are unique per pair (with
-- canonical ordering: member_a < member_b). Conversation creation is
-- gated by are_connected() so messaging only opens between members
-- with an accepted intro on either side.
------------------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  member_a        uuid not null references public.members(id) on delete cascade,
  member_b        uuid not null references public.members(id) on delete cascade,
  intro_id        uuid references public.intro_requests(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (member_a < member_b),
  unique (member_a, member_b)
);

create index conversations_member_a_idx       on public.conversations (member_a);
create index conversations_member_b_idx       on public.conversations (member_b);
create index conversations_last_message_idx   on public.conversations (last_message_at desc);

alter table public.conversations enable row level security;

create policy "conversations_select_party" on public.conversations
  for select to authenticated
  using (member_a = auth.uid() or member_b = auth.uid());

create policy "conversations_insert_connected_party" on public.conversations
  for insert to authenticated
  with check (
    (member_a = auth.uid() or member_b = auth.uid())
    and public.are_connected(member_a, member_b)
  );

create policy "conversations_delete_admin" on public.conversations
  for delete to authenticated using (public.is_admin());

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender_id        uuid not null references public.members(id) on delete cascade,
  body             text not null check (length(body) between 1 and 5000),
  created_at       timestamptz not null default now(),
  read_at          timestamptz
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

create policy "messages_select_party" on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  );

create policy "messages_insert_party" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  );

-- Recipients (non-senders) can mark a message read by setting read_at.
create policy "messages_update_recipient_read" on public.messages
  for update to authenticated
  using (
    sender_id <> auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  )
  with check (
    sender_id <> auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  );

create policy "messages_delete_admin" on public.messages
  for delete to authenticated using (public.is_admin());

-- Touch conversation.last_message_at when a new message is inserted.
create or replace function public.messages_touch_conversation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.conversations
  set last_message_at = new.created_at
  where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
after insert on public.messages
for each row execute function public.messages_touch_conversation();

------------------------------------------------------------------------
-- Storage: avatars bucket
-- Public read so <img src> works; authenticated users can write only
-- inside a folder named after their own auth.uid().
------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880,
        array['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- No SELECT policy on avatars. Public buckets serve files via
-- /storage/v1/object/public/<bucket>/<path>, which bypasses RLS. A
-- broad SELECT policy here would let clients enumerate every uploaded
-- avatar via storage.from('avatars').list() — we don't need that
-- listing surface, so we omit the policy entirely. <img src> rendering
-- is unaffected.

create policy "avatars_owner_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_owner_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_owner_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

------------------------------------------------------------------------
-- Trigger function lockdown
--
-- The trigger functions below are SECURITY DEFINER so they can do
-- privileged operations regardless of who fired the trigger:
--   • applications_send_confirmation / send_status_change → call net.http_post
--     (anon doesn't have EXECUTE on net.http_post)
--   • intro_requests_notify / notify_insert → same, via pg_net
--   • intro_requests_open_conversation → INSERT into conversations
--     bypassing the are_connected RLS gate at the moment a target accepts
--
-- They're called only by triggers internally, never as RPCs. Revoke
-- EXECUTE from PUBLIC so anon + authenticated can't call them through
-- /rest/v1/rpc/<fn>. Postgres triggers bypass EXECUTE grants.
------------------------------------------------------------------------
revoke execute on function public.applications_send_confirmation()        from public;
revoke execute on function public.applications_send_status_change()       from public;
revoke execute on function public.intro_requests_notify()                 from public;
revoke execute on function public.intro_requests_notify_insert()          from public;
revoke execute on function public.intro_requests_open_conversation()      from public;

------------------------------------------------------------------------
-- pg_cron jobs
------------------------------------------------------------------------
-- Auto-archive past events. Hourly: any 'upcoming' event whose
-- ends_at (or starts_at fallback) has passed flips to 'past'.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'events_auto_archive') then
    perform cron.unschedule('events_auto_archive');
  end if;
end $$;

select cron.schedule(
  'events_auto_archive',
  '0 * * * *',
  $cron$
    update public.events
    set status = 'past'
    where status = 'upcoming'
      and coalesce(ends_at, starts_at) < now();
  $cron$
);

-- Auto-expire stale intros. Nightly: any pending intro >30d old → expired.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'intro_requests_auto_expire') then
    perform cron.unschedule('intro_requests_auto_expire');
  end if;
end $$;

select cron.schedule(
  'intro_requests_auto_expire',
  '15 3 * * *',
  $cron$
    update public.intro_requests
    set status = 'expired'
    where status = 'pending'
      and created_at < now() - interval '30 days';
  $cron$
);

------------------------------------------------------------------------
-- Realtime publication
-- The supabase_realtime publication exists by default but ships empty.
-- Tables must be added explicitly so client-side .on('postgres_changes')
-- subscriptions actually receive payloads.
------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.intro_requests;

------------------------------------------------------------------------
-- Storage: event-images bucket
-- Admin-uploaded event covers. Public read so the events list renders
-- them anonymously; only admins can write/update/delete.
------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-images', 'event-images', true, 5242880,
        array['image/png','image/jpeg','image/jpg','image/webp']::text[])
on conflict (id) do nothing;

create policy "event_images_read_public" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'event-images');

create policy "event_images_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'event-images' and public.is_admin());

create policy "event_images_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'event-images' and public.is_admin())
  with check (bucket_id = 'event-images' and public.is_admin());

create policy "event_images_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'event-images' and public.is_admin());
