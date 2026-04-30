# Architecture — Phase 1 (Pilot)

This document captures the architectural decisions for the Aether pilot (~100–200 testers at Spring Place NY). Phase 2 is explicitly out of scope here.

---

## Stack

- **Frontend:** Static HTML / CSS / JavaScript deployed via GitHub Pages. No build system, no framework.
- **Backend:** Supabase (managed Postgres + Auth + Storage). The frontend calls Supabase directly from the browser using the official JS client loaded from a CDN.

---

## Why Supabase

- Provides Postgres, magic-link email auth, row-level security, and email delivery in a single managed dependency.
- We are not operating any servers ourselves. The ~6-week pilot timeline doesn't accommodate building auth + email + DB hosting from scratch.
- Free tier comfortably covers 100–200 users.
- Vendor lock-in is acceptable for phase 1. If the pilot proves demand, phase 2 can re-evaluate — Supabase exposes the underlying Postgres directly and supports auth-user export, so migration is bounded.

---

## Why GitHub Pages (retained)

- The static demo has been visually validated by Paris and Alessandro. Adding Supabase as a layer preserves all that work; rewriting the frontend would burn 2–3 weeks of the budget.
- We do not need server-side rendering or environment variables. The Supabase project URL and the public **anon** key are safe to commit (see Security).
- A second hosting migration (to Vercel/Netlify) would solve no phase-1 problem.

---

## Phase 1 — in scope (~6 weeks)

- Magic-link email auth (invite-only)
- Member profiles — read by all members, edited by the member themself
- Member directory — live data
- Application capture — public submit; admin review queue
- Intro requests — warm-intro mechanic; visible to requester, broker, and admins only
- Events + RSVPs — admin-curated events; members RSVP
- Partner spaces — data layer present; UI stays static for v1

## Phase 2 — explicitly deferred

- AI vetting bot (phase 1 = human review only)
- Mentorship matching (phase 1 = direct admin coordination)
- Capital / merchant banking layer
- Multiple cities beyond Spring Place NY
- Native mobile apps
- Sophisticated rate limiting and bot mitigation (phase 1 relies on the apply form being unadvertised + RLS defaults)
- Re-evaluation of vendor lock-in / hosting migration

---

## Security — the load-bearing rule

> **Only the Supabase ANON key is permitted in client-side code or this repository. The SERVICE ROLE key bypasses RLS and grants full database access — it must NEVER be committed, NEVER deployed to GitHub Pages, NEVER appear in any HTML or JS file.**

If a future operation requires the service role (e.g. an admin batch action, a privileged email send), it runs server-side in a Supabase Edge Function or a separate process — never in the browser. RLS policies on every table are the only thing standing between an authenticated user and unauthorized data; treat them as load-bearing.

A few corollaries:

- The admin allowlist is enforced both in the database (via `public.is_admin()` in `supabase/schema.sql`) and in the client (via `ADMIN_EMAILS` in `supabase.js`). The DB enforcement is the real one — the client copy only controls UI visibility. Always assume the client is hostile.
- Magic-link sign-in uses `shouldCreateUser: false` so unauthorised emails cannot self-register. New members are created only after admin approval.
- The login form returns the same generic message regardless of whether the email is registered (anti-enumeration).
- Defensive triggers protect sensitive columns (`members.status`, `applications.status`, `intro_requests.broker_id`, etc.) against malicious updates that pass RLS — defence in depth.

---

## Phase-1 file map

| File | Purpose |
|---|---|
| `ARCHITECTURE.md` | This file |
| `supabase/schema.sql` | Tables, indexes, RLS policies, triggers, `is_admin()` helper |
| `supabase.js` | Supabase client init + session helpers (`window.aether.*`) |
| `auth.js` | Page guards (`requireAuth`, `requireAdmin`) |
| `login.html` / `login.js` / `login.css` | Magic-link login page |

Pages that require authentication should include the following before any other page-specific JS:

```html
<script src="https://unpkg.com/@supabase/supabase-js@2"></script>
<script src="supabase.js"></script>
<script src="auth.js"></script>
<script>aether.requireAuth();</script>
```

For admin-only pages, call `aether.requireAdmin()` instead.

---

## Supabase project setup (for Owen, when creating the live project)

These are dashboard-level configurations the SQL alone cannot set:

1. **Email auth enabled** (default).
2. **Site URL** = `https://owen-alderson.github.io/elite-network-platform/`
3. **Redirect URL allowlist** — add at least `https://owen-alderson.github.io/elite-network-platform/dashboard.html` and any other authenticated landing pages. Supabase rejects redirects not on this list.
4. **Email template** — customise the magic-link email to match the Aether wordmark + dark/gold aesthetic before the first invite goes out.
5. **Apply `supabase/schema.sql`** via the SQL editor (one-shot; it is not idempotent on re-run).
6. **Manual member creation flow (phase 1):** when an application is approved, an admin (a) invites the email via `auth.admin.inviteUserByEmail` from the Supabase dashboard, (b) inserts the corresponding `members` row with the `id` matching the new auth user's id. This is intentionally manual for the first ~100 users; an Edge Function can automate it later.
