# Supabase Auth — Email Templates

Branded HTML for Supabase Auth's three transactional emails:

- **`magic-link.html`** — sent when a member signs in by leaving the password field blank on `login.html`, or clicks "Send me a magic link instead." First sign-in + emergency fallback. Once members set a password, this fires rarely.
- **`invite-user.html`** — sent when admin approves an application via the `invite-member` Edge Function (`auth.admin.inviteUserByEmail`). First contact for new testers.
- **`recovery.html`** — sent when a member clicks "Forgot password?" on `login.html`. Triggers `auth.resetPasswordForEmail` with `redirectTo` pointing at `set-password.html`. Click → Supabase auto-establishes a recovery session → user lands on `set-password.html` and sets a new password.

All three use the dark/gold palette + Cormorant Garamond + Inter — same shell as the Resend transactional emails (`send-application-confirmation`, `send-application-status`, `send-intro-notification`).

## How to deploy

These templates aren't in the source pipeline. Supabase Auth templates live in the dashboard. Paste them in:

1. Open https://supabase.com/dashboard/project/emlresxklixzcsammste/auth/templates
2. **Magic Link** template:
   - **Subject:** `Your sign-in link to Aether`
   - **Body:** paste contents of `magic-link.html`
   - Save
3. **Invite User** template:
   - **Subject:** `You're in. Welcome to Aether.`
   - **Body:** paste contents of `invite-user.html`
   - Save
4. **Reset Password** template:
   - **Subject:** `Reset your Aether password`
   - **Body:** paste contents of `recovery.html`
   - Save

## Variables

Supabase Auth templates use Go-template syntax. Available in both:

| Variable | What it is |
|---|---|
| `{{ .ConfirmationURL }}` | The signed magic-link URL — what the CTA button + fallback paragraph link to |
| `{{ .Email }}` | The recipient's email — used in the invite copy to make it feel personal |
| `{{ .Token }}` | The 6-digit OTP, if you ever switch to OTP-based flow (not used today) |
| `{{ .SiteURL }}` | The configured site URL (`https://owen-alderson.github.io/elite-network-platform/`) |

There is **no first-name variable** in these templates — Supabase Auth doesn't have access to the `members` table at send time. The invite copy is intentionally email-shaped, not name-shaped, to work around this.

## Testing

After pasting:

1. **Magic link:** sign in via `login.html` with your own admin email → check inbox.
2. **Invite user:** create a test application via `apply.html` → approve it from `admin.html` → check the test inbox.

Both should land with the AETHER wordmark up top, the Cormorant headline, and a gold CTA. If they render with generic Supabase chrome, the paste didn't take.

## Known caveats

- **Outlook (older versions)** strips the `<style>` block. The fallback is system fonts on a black background — readable but not branded. Acceptable for the elite-tester audience that uses Apple Mail / Gmail.
- **Dark-mode-aware Gmail** can invert backgrounds. We deliberately use a dark background, so this is fine.
- **Cormorant Garamond** isn't a web-safe font. The `font-family` chain falls back to Georgia, then serif. The headline still reads correctly even without the brand font.
