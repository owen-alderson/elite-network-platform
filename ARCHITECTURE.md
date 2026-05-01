# Architecture — Aether (Phase 1 Pilot)

This document is the canonical reference for what's running in production. It's updated whenever something material changes. Everything below reflects state through **2026-05-01**.

The Phase 1 target is the Spring Place NY pilot — ~100–200 testers — and a 6-week build window. Phase 2 (multi-city expansion, AI vetting bot, capital layer, etc.) is explicitly deferred and out of scope for this document.

---

## Stack

- **Frontend:** Static HTML / CSS / JavaScript deployed via GitHub Pages. No build system, no framework. Pure DOM + Supabase JS client loaded from a CDN.
- **Backend:** Supabase (managed Postgres + Auth + Storage + Edge Functions). The frontend talks directly to Supabase from the browser using the **publishable** key.
- **Email:** Resend, called from Edge Functions via `pg_net` triggers. Currently in sandbox mode (no verified domain yet).
- **Realtime:** Supabase Realtime channels for live message updates in conversations.
- **Cron:** `pg_cron` extension for hourly events archival + nightly intro expiry.

---

## Security — the load-bearing rule

> **Only the publishable (anon) key is permitted in client-side code or this repository. The service-role key bypasses RLS and grants full database access — it must NEVER be committed, NEVER deployed to GitHub Pages, NEVER appear in any HTML or JS file.**

Service-role usage is confined to:
- Edge Functions (read the key from Supabase env vars at runtime)
- Direct admin pathways (Supabase dashboard, MCP `execute_sql`)

RLS policies on every public table are the only thing standing between an authenticated user and unauthorized data. Treat them as load-bearing. Defensive triggers are layered on top for defence in depth.

### `is_admin()` recognises three classes of caller as admin:

1. **Direct DB pathways** — `current_user IN ('postgres', 'service_role', 'supabase_admin')`. Covers MCP-direct queries, the SQL editor, and any other privileged DB connection.
2. **Service-role JWTs** — `auth.jwt() ->> 'role' = 'service_role'`. Covers Edge Functions using `SUPABASE_SERVICE_ROLE_KEY`.
3. **Admin email allowlist** — `auth.jwt() ->> 'email' IN ('owen.alderson@gmail.com')`. Covers the human admin signed in through the browser.

(1) and (2) are critical — without them, defensive triggers silently revert legitimate privileged writes from Edge Functions. We hit this exact bug with Keira Paterson's first approval; fix shipped 2026-05-01.

---

## Phase 1 — what's in scope

| Feature | Status |
|---|---|
| Magic-link email auth (invite-only) | ✅ Live |
| Member directory (live data, search, pillar filter) | ✅ Live |
| Member profile (view + edit by self; admin can reclassify pillar) | ✅ Live |
| Avatar upload (Supabase Storage) | ✅ Live |
| Application capture (anon submit) + admin review queue | ✅ Live |
| Approve → invite + member creation (Edge Function) | ✅ Live |
| Application duplicate prevention | ✅ Live |
| Intro requests with conditional routing (broker vs direct) | ✅ Live |
| Connection-gated 1:1 messaging with Realtime | ✅ Live |
| Events admin (create / edit / delete / mark past) + RSVPs | ✅ Live |
| Partner spaces (live data, admin CRUD, public-facing page) | ✅ Live |
| Email notifications via Resend | ✅ Live (sandbox — blocked on domain verification) |
| Auto-archival cron (events + intros) | ✅ Live |

## Phase 2 — explicitly deferred

- AI vetting bot (phase 1 is human review only, sole admin)
- Mentorship matching (phase 1 = direct admin coordination)
- Capital / merchant banking layer (requires ~50k members per Paris call)
- Multiple cities beyond Spring Place NY
- Native mobile apps
- Sophisticated rate limiting + bot mitigation (phase 1 relies on apply form being unadvertised + RLS defaults + a partial unique index on pending applications)
- Notifications schema beyond intros (events cancelled, member status changes, etc.)

---

## Database schema

Canonical source: `supabase/schema.sql`. Updated whenever migrations land.

### Tables (in dependency order)

| Table | Purpose | RLS gist |
|---|---|---|
| `partner_spaces` | Curated venues members can access (Spring Place NY confirmed; others prospective). | Public read (anon + authed); admin write |
| `members` | Each row keyed to `auth.users(id)`. Created post-approval via `invite-member`. | Active members visible to authed; member edits self; admin edits anyone; **`primary_pillar` admin-only-mutable** |
| `applications` | Public submission allowed (anon insert). Admin-only review. | Anyone insert; admin select / update / delete |
| `intro_requests` | The core mechanic. `route='broker'` or `'direct'`, decided by trigger at insert. | Requester / broker / direct-target / admin SELECT; same for UPDATE; admin delete |
| `events` | Admin-curated; all members read. | Authed read; admin write |
| `event_rsvps` | One row per (event, member). | Authed read; member manages own; admin all |
| `conversations` | 1:1 DM; canonical ordering `member_a < member_b` so each pair has exactly one row. | Participants only; insert gated by `are_connected()` |
| `messages` | Body 1–5000 chars; `read_at` for read state. | Conversation participants only; sender inserts; recipient marks read |

### Helper SQL functions

- **`is_admin()`** — described above. Three pathways accepted as admin.
- **`are_connected(a, b)`** — strict definition of a connection: there exists an `accepted` intro between `a` and `b` on either side.
- **`has_mutual_connection(a, b)`** — used by the routing trigger. Returns true if any third member is `are_connected()` to both `a` and `b`.
- **`touch_updated_at()`** — generic `updated_at` setter, attached to `partner_spaces`.

### Defensive column triggers

- **`members_protect_columns`** (BEFORE UPDATE) — non-admin can't change `id, email, status, nominated_by, joined_at, created_at, primary_pillar`. Always sets `updated_at = now()`.
- **`applications_force_defaults`** (BEFORE INSERT/UPDATE) — non-admin can't set `status, reviewed_by, reviewed_at, reviewer_notes, created_member_id, confirmation_sent_at, status_email_sent_at`. Forces them to defaults / preserves prior values on UPDATE.
- **`intro_requests_protect_columns`** (BEFORE UPDATE) — non-admin can't change `id, requester_id, target_id, broker_id, note, created_at, route`. Effectively only `status / forwarded_at / responded_at` are mutable post-insert by non-admins.

### Routing + rate-limit triggers (intro_requests)

- **`intro_requests_set_route`** (BEFORE INSERT) — calls `has_mutual_connection()`, sets `route = 'broker'` or `'direct'`.
- **`intro_requests_check_direct_limit`** (BEFORE INSERT) — raises `check_violation` if requester already has 5 pending direct intros.
- **`intro_requests_open_conversation`** (AFTER UPDATE, security definer) — when status flips to `accepted`, creates the conversation row (canonical-order `member_a < member_b`) and seeds it with the requester's note as the first message.

### Email triggers (call Edge Functions via `pg_net`)

- **`applications_send_confirmation`** (AFTER INSERT) → `send-application-confirmation`
- **`applications_send_status_change`** (AFTER UPDATE) → `send-application-status`, when status flips to `rejected` or `needs_more_info`
- **`intro_requests_notify_insert`** (AFTER INSERT) → `send-intro-notification` with event=`direct_received` when route=`direct`
- **`intro_requests_notify`** (AFTER UPDATE) → `send-intro-notification` with one of:
  - `broker_assigned` — broker_id transitions null → set on a still-pending intro
  - `forwarded` — status transitions to `forwarded`
  - `direct_accepted` — status transitions to `accepted` AND route=`direct`

`pg_net` lives in the `net` schema. Triggers must call `net.http_post(...)`. We hit `extensions.http_post does not exist` once when the wrong schema was used — fixed in `fix_http_post_schema` migration.

### Storage bucket: `avatars`

Public read so `<img src>` works without signed URLs. Authenticated users can write only inside a folder named after their own `auth.uid()`. Path convention: `avatars/<user-id>/<filename>`. 5 MB limit, image MIME types only.

### Indexes

Standard indexes on FK + status / starts_at / route / member_a / member_b / etc. Two important partial unique indexes for behavioural enforcement:

- **`applications_unique_open_email`** — `(lower(applicant_email)) WHERE status IN ('pending', 'needs_more_info')`. Blocks duplicate open applications for the same email; closed apps (rejected, approved) free the email up.
- **`intro_requests_unique_pending_pair`** — `(requester_id, target_id) WHERE status='pending'`. Blocks duplicate pending intros from the same requester to the same target.

### Cron jobs (`pg_cron`)

- **`events_auto_archive`** — hourly. `UPDATE events SET status='past' WHERE status='upcoming' AND coalesce(ends_at, starts_at) < now()`.
- **`intro_requests_auto_expire`** — nightly at 03:15 UTC. `UPDATE intro_requests SET status='expired' WHERE status='pending' AND created_at < now() - INTERVAL '30 days'`.

---

## Edge Functions

All deployed at the project URL `https://emlresxklixzcsammste.supabase.co/functions/v1/<slug>`. Source in `supabase/functions/<slug>/index.ts`. Deploy via `mcp__supabase__deploy_edge_function`.

### `invite-member` (verify_jwt: true)
Admin-only. Takes `{ application_id }`, validates caller is on `ADMIN_EMAILS`, finds-or-invites the auth user via `auth.admin.inviteUserByEmail`, upserts the `members` row from application data, stamps `applications.created_member_id`. Idempotent. Used by the admin's "Approve" action on the applications queue.

### `send-application-confirmation` (verify_jwt: false)
Fires on every application INSERT via the `applications_send_confirmation` trigger. Idempotent on `applications.confirmation_sent_at`. Subject: "We received your application — Aether".

### `send-application-status` (verify_jwt: false)
Fires on application UPDATE when status flips to `rejected` or `needs_more_info`. Idempotent on `applications.status_email_sent_at`. Includes reviewer notes inline. Branched copy per status.

### `send-intro-notification` (verify_jwt: false)
Fires on intro INSERT (direct route → emails target) and intro UPDATE (broker assigned, forwarded, direct accepted). Single function with four event-type branches.

### Required secrets (Supabase Dashboard → Edge Functions → Settings → Secrets)

| Secret | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | auto-injected | |
| `SUPABASE_ANON_KEY` | auto-injected | |
| `SUPABASE_SERVICE_ROLE_KEY` | auto-injected | |
| `RESEND_API_KEY` | yes | Set 2026-05-01. Without this, all email functions gracefully no-op. |
| `AETHER_FROM_EMAIL` | optional | Defaults to `Aether <onboarding@resend.dev>` (sandbox). Set to `Aether <hello@yourdomain.com>` once domain is verified on Resend. |

---

## Frontend file map

### Public (no auth required, but `auth.js` runs to swap CTA / wordmark when session exists)

| File | Purpose |
|---|---|
| `index.html` | Landing page — hero, pillars, spaces strip, how-it-works, apply CTA |
| `events.html` + `events.js` | Live events list with Upcoming / Past toggle |
| `event.html` + `event.js` | Event detail + RSVP toggle (live data) |
| `spaces.html` + `spaces.js` | Live partner_spaces grid |
| `venue-spring-place.html` + `venue.css` | Hero + facility detail page for Spring Place NY |
| `partners.html` + `partners.css` | Partnership pitch page |
| `apply.html` + `apply.js` + `apply.css` | Two-flow form: applicant (5 screens) and nominator (3 screens). Entry-card gating by session state. Duplicate-pending detection. |
| `login.html` + `login.js` + `login.css` | Magic-link send + redirect-back flow |

### Authenticated (auth.js calls `requireAuth()` or `requireAdmin()`)

| File | Purpose |
|---|---|
| `dashboard.html` + `dashboard.js` + `dashboard.css` | Logged-in home: greeting, intro requests for you (direct), broker queue, your intro requests, connections, upcoming events, suggested connections, inbox panel |
| `members.html` + `members.js` | Directory with sidebar pillar filter + name/headline/bio/city/current-work search |
| `profile.html` + `profile.js` + `profile.css` | View + edit profile. Edit mode includes photo upload, achievements editor, secondary-pillar chips, link fields. Action button is relationship-aware (Send message / Request pending / Request Introduction). Profile completeness banner on own profile. Connection count meta row. |
| `messages.html` + `messages.js` + `messages.css` | DM inbox + thread. Realtime via Supabase channels. `?with=<id>` opens a specific thread. |
| `admin.html` + `admin.js` + `admin.css` | Five tabs: Applications, Intros, Events, Members, Spaces. Full CRUD where applicable. |

### Shared

| File | Purpose |
|---|---|
| `style.css` | Global styles. Modal + nav + buttons + form elements + member cards + inbox panel + connections grid + dashboard event rows + status badges + spaces grid + members search + events toggle + avatar img + nav-session chip + sign-in/sign-out links |
| `nav.js` | Hamburger toggle. Mobile menu open/close. |
| `supabase.js` | Supabase client init. Exports `aether.{client, getSession, getUser, signInWithMagicLink, signOut, isAdmin, onAuthStateChange, fillAvatar, uploadAvatar, ADMIN_EMAILS}`. |
| `auth.js` | Page guards (`requireAuth`, `requireAdmin`). DOMContentLoaded hook: hides `.nav-cta` / `.mobile-cta` / `.nav-signin` / `.mobile-signin` when session exists; rewrites wordmark to dashboard; injects nav session chip + Messages link + Admin link (the latter only for admins); injects mobile sign-out. |
| `intro.js` | Request Introduction modal. Shows route hint (broker vs direct) before submit via `has_mutual_connection()` RPC. Surfaces specific copy for unique-violation + rate-limit errors. |
| `favicon.svg` | Aether wordmark glyph |

### Backend (in repo, deployed via MCP)

| File | Purpose |
|---|---|
| `supabase/schema.sql` | Canonical schema. Reflects every applied migration. |
| `supabase/functions/invite-member/index.ts` | Application approval → member creation. |
| `supabase/functions/send-application-confirmation/index.ts` | Application confirmation email. |
| `supabase/functions/send-application-status/index.ts` | Application rejected / needs_more_info email. |
| `supabase/functions/send-intro-notification/index.ts` | Four event types: broker_assigned, forwarded, direct_received, direct_accepted. |

### Auth wiring on a page

```html
<script src="https://unpkg.com/@supabase/supabase-js@2"></script>
<script src="supabase.js"></script>
<script src="auth.js"></script>
<script>aether.requireAuth();</script>
<!-- page-specific JS below -->
```

For admin-only pages, call `aether.requireAdmin()` instead. Public pages skip the `requireAuth` line but still load supabase.js + auth.js so the nav chip / wordmark / CTAs reflect session state.

---

## Auth flow

1. Visitor lands on `login.html` (or gets bounced there by `requireAuth`)
2. Enters email → `signInWithMagicLink({ shouldCreateUser: false })`
3. Supabase emails a magic link (Supabase's own SMTP — separate from Resend; this works without a verified domain)
4. Visitor clicks link → returns with `?type=magiclink&access_token=...&refresh_token=...` → Supabase JS client `detectSessionInUrl: true` consumes it and stores session in localStorage
5. Page redirects to `dashboard.html` (or wherever `?redirect=...` says)
6. `aether.requireAuth()` confirms session, page renders

`shouldCreateUser: false` is critical — it means only invited users (i.e. members created via `invite-member`) can sign in. Random emails get a generic "we'll be in touch" response, no account created.

The login form returns the same generic message regardless of whether the email is registered — anti-enumeration.

---

## Email pipeline

Five distinct transactional emails live; one auth invite via Supabase.

| Sender | Trigger | Recipient | Path |
|---|---|---|---|
| Supabase Auth | `auth.admin.inviteUserByEmail` (called from `invite-member`) | Approved applicant | Supabase SMTP — works without Resend domain |
| Resend | `applications_send_confirmation` trigger | Applicant on submit | `send-application-confirmation` Edge Function |
| Resend | `applications_send_status_change` trigger | Applicant on rejected / needs_more_info | `send-application-status` Edge Function |
| Resend | `intro_requests_notify_insert` trigger | Target on direct intro | `send-intro-notification` event=direct_received |
| Resend | `intro_requests_notify` trigger | Broker on assignment | `send-intro-notification` event=broker_assigned |
| Resend | `intro_requests_notify` trigger | Requester on forwarded | `send-intro-notification` event=forwarded |
| Resend | `intro_requests_notify` trigger | Requester on direct accepted | `send-intro-notification` event=direct_accepted |

See [Atlas/AI Tools/Resend.md](../Obsidian%20Vault/Atlas/AI%20Tools/Resend.md) (in the vault, not the repo) for full Resend operational reference.

---

## Intro routing — the core product mechanic

When member A submits an intro request to member B, the `intro_requests_set_route` trigger picks one of two paths:

### Broker route (`route='broker'`)
Triggered when `has_mutual_connection(A, B)` returns true — i.e. some third member C has an accepted intro with both A and B.

1. Insert: status=pending, broker_id=null
2. Admin assigns broker → `intro_requests_notify` fires `broker_assigned` email to broker
3. Broker sees it on dashboard "Intros for you to make" → clicks Mark Forwarded (off-platform handoff happens here, separately) → `intro_requests_notify` fires `forwarded` email to requester
4. Requester sees forwarded status → clicks Mark Accepted → `intro_requests_open_conversation` opens the DM thread

### Direct route (`route='direct'`)
Triggered when no mutual connection exists. Common at launch — connection graph is sparse. Becomes rarer as accepted intros accumulate.

1. Insert: status=pending, broker_id=null, route=direct → `intro_requests_notify_insert` fires `direct_received` email to target
2. Target sees it on dashboard "Intro requests for you" → Accept or Decline
3. Accept → `intro_requests_open_conversation` opens the DM thread → `intro_requests_notify` fires `direct_accepted` email to requester
4. Decline → status=declined; no email

### Connection definition (strict)

A **connection** is an `intro_requests` row with `status='accepted'`. Nothing softer (shared event RSVP, same pillar+city, etc.) counts.

Connection unlocks:
- Future intro requests between the connected members can find mutuals via `has_mutual_connection()`
- DM access via `are_connected()` gating on `conversations` INSERT

### Rate limits

- **5 pending direct requests per requester** at any time. DB raises `check_violation` on the 6th. Resolved when a pending request closes (forwarded, accepted, declined, expired).
- **No duplicate pending intro between the same requester / target pair.** DB has a partial unique index — `intro_requests_unique_pending_pair`. Resolved when the existing request closes.

### State machine

```
pending → [admin assigns broker]   → pending (with broker)  →[broker forwards]→ forwarded → [requester marks accepted]→ accepted
pending → [admin assigns broker]   → pending (with broker)  →[broker declines]→ declined
pending → [requester cancels]      → declined
pending → [target accepts on direct] → accepted
pending → [target declines on direct] → declined
pending → [30 days elapsed]        → expired (cron)
```

`accepted` and `declined` and `expired` are terminal.

---

## Messaging

Connection-gated 1:1 DM. Conversations created automatically on intro acceptance (server-side trigger). Cannot be created any other way — RLS on `conversations` INSERT requires `are_connected()` to return true plus the caller being one of the parties. This is the **spam-prevention guarantee**: members can only message those they're actually connected to.

- `messages.html` shows the conversation list (left pane) + active thread (right pane on desktop, fullscreen on mobile)
- `?c=<conv_id>` opens a specific thread; `?with=<member_id>` finds + opens the existing thread with that member
- Realtime subscription on the open thread for live message arrival (`supabase.channel('messages:<conv_id>')`)
- Read state tracked per message via `read_at` (recipient marks as read on open + on every realtime arrival)
- Send box: Enter to send, Shift-Enter for newline. 5,000-char body limit.

---

## Admin surface

`admin.html` is gated by `requireAdmin()`. Five top-level tabs:

| Tab | Capabilities |
|---|---|
| **Applications** | Status filter tabs (pending, needs_more_info, approved, rejected, all). Stat cards. Per-row Approve / Needs Info / Reject. Approve fires `invite-member`. Other actions trigger the status email function via the UPDATE trigger. |
| **Intros** | Status filter tabs (awaiting broker, with broker, forwarded, declined, all). Stat cards. Per-row member-dropdown to assign a broker (excluding requester + target) plus Decline. |
| **Events** | Create / Edit / Delete. Mark Past on upcoming events for manual override. cron auto-archives anyway. |
| **Members** | Status filter tabs (active, paused, removed, all). Stat cards. Per-row Pause / Reactivate / Remove + a primary-pillar dropdown for admin reclassification. |
| **Spaces** | Create / Edit / Delete partner_spaces. Status (confirmed / prospective / inactive) and founding-partner toggle. |

Admin nav link is auto-injected for the sole admin (Owen) via `auth.js` on every page that loads it.

---

## Supabase project setup (one-time, by Owen)

These are dashboard configurations the SQL alone cannot set:

1. **Email auth enabled** (default).
2. **Site URL** — `https://owen-alderson.github.io/elite-network-platform/` (will become `https://yourdomain.com/` once domain lands).
3. **Redirect URL allowlist** — `https://owen-alderson.github.io/elite-network-platform/**` and any local dev URLs.
4. **Email template** — magic-link template can be customized in the dashboard. Currently uses Supabase default; on-brand customization is a nice-to-have before sending invites to non-Owen testers.
5. **Apply `supabase/schema.sql`** if deploying to a fresh project. Non-idempotent — single-shot.
6. **Edge Function secrets** — `RESEND_API_KEY` + (optionally) `AETHER_FROM_EMAIL`. See `supabase/functions/<each>/index.ts` headers for setup notes.

---

## Open issues / known blockers

| Issue | Status | Blocker for |
|---|---|---|
| **No verified domain on Resend** | Active blocker | All transactional emails to non-Owen recipients (Resend sandbox limit). See vault note `Aether - Domain & Email Setup.md`. Pending cofounder agreement on platform name before registering. |
| **GitHub Pages cache** | Mitigated | Files served with `Cache-Control: max-age=600`. After a JS deploy, append `?v=N` to the script tag in HTML to force fresh fetch. Currently only `members.js?v=2` is busted — others use whatever the browser cached. |
| **No deliverability dashboard inside Aether** | Acceptable phase 1 | Resend's own dashboard (https://resend.com/emails) is the source of truth. |
| **No retry on email send failure** | Acceptable phase 1 | If Resend is down, that single email is lost. The `*_sent_at` columns are only stamped on success; theoretically retriable, but no automation for it. |

---

## What's still on the post-domain list

Not blockers but useful additions when bandwidth opens up:

- **Notifications schema** beyond intros (event cancelled, member status changes, etc.) — currently the inbox feed is intro-only.
- **Application duplicate UX** — apply form's a-confirm shows generic message; could detect duplicate before submit and show a friendlier path for re-applying.
- **Admin "today" overview** — top-of-admin view summarizing pending counts + recent activity. Useful at scale.
- **Profile-page hover preview** in the directory.
- **Member-facing application status check** — page where someone enters their email and sees the current status (currently only email-driven).
- **Email digest options** — phase 1 sends per-event; testers may prefer one daily digest. Phase 2 once we have user preferences.

---

## Repo layout

```
/
├── *.html (page-specific markup)
├── *.css (page-specific styles)
├── *.js  (page-specific JS)
├── style.css (global)
├── nav.js / supabase.js / auth.js / intro.js (shared)
├── favicon.svg
├── ARCHITECTURE.md (this file)
├── CLAUDE.md (Karpathy-flavored coding guidelines for working in this repo)
└── supabase/
    ├── schema.sql (canonical schema)
    └── functions/
        ├── invite-member/index.ts
        ├── send-application-confirmation/index.ts
        ├── send-application-status/index.ts
        └── send-intro-notification/index.ts
```

Live deploy: GitHub Pages, `main` branch root.
Live database: Supabase project `emlresxklixzcsammste`.
