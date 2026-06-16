// send-member-invite — ADMIN-ONLY. Emails an existing member a branded
// one-click magic-link "welcome / sign in" email.
//
// Why this exists: the founding members were seeded directly into
// auth.users (no password, never signed in). invite-member only emails
// NEW users created from an approved application, so it can't reach them.
// Admin picks a member in admin.html and fires this; the member gets a
// sign-in link straight to their dashboard (no password needed first time).
//
// SECURITY: uses the service role key, so it MUST verify the caller is on
// the admin allowlist before doing anything (mirrors invite-member).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("MAIA_FROM_EMAIL") || "Maia <onboarding@resend.dev>";
const SITE_URL = "https://maiacircle.com";

// Mirrors public.is_admin() in supabase/schema.sql. Sole admin in phase 1.
const ADMIN_EMAILS = ["owen.alderson@gmail.com"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...cors, "Content-Type": "application/json" },
    status,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 1. Authenticate caller via their JWT, then check the admin allowlist.
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthenticated" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "unauthenticated" }, 401);
  const callerEmail = (userData.user.email || "").toLowerCase();
  if (!ADMIN_EMAILS.includes(callerEmail)) return json({ error: "forbidden" }, 403);

  // 2. Validate input.
  let body: { member_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const memberId = body.member_id;
  if (!memberId) return json({ error: "member_id required" }, 400);

  if (!RESEND_API_KEY) return json({ error: "resend_not_configured" }, 500);

  // 3. Service-role client for privileged work.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4. Look up the member.
  const { data: member, error: memberErr } = await admin
    .from("members")
    .select("id, email, full_name")
    .eq("id", memberId)
    .maybeSingle();
  if (memberErr) return json({ error: memberErr.message }, 500);
  if (!member) return json({ error: "member not found" }, 404);
  const email = (member.email || "").toLowerCase();
  if (!email) return json({ error: "member has no email" }, 400);
  const firstName = (member.full_name || "there").trim().split(/\s+/)[0];

  // 5. Magic link — one-time sign-in URL embedded in the email.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: SITE_URL + "/dashboard.html" },
  });
  if (linkErr) return json({ error: "link_failed: " + linkErr.message }, 500);
  const actionLink = linkData?.properties?.action_link;
  if (!actionLink) return json({ error: "link_missing" }, 500);

  // 6. Send the branded welcome email.
  const subject = `Welcome to Maia, ${firstName}`;
  const html = welcomeHtml(firstName, actionLink);
  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [email], subject, html }),
  });
  if (!resendRes.ok) {
    const text = await resendRes.text();
    console.error("Resend send failed:", resendRes.status, text);
    return json({ error: "resend_failed", status: resendRes.status, detail: text }, 500);
  }

  return json({ sent: true, email }, 200);
});

// One value-prop row: gold uppercase label on the left, plain-language
// payoff on the right. Four of these carry the homepage's four pillars
// into the welcome email so the promise reads the same everywhere.
function vpRow(label: string, desc: string): string {
  return `<tr>
    <td style="vertical-align:top;padding:8px 16px 8px 0;white-space:nowrap;color:#c9a84c;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;">${label}</td>
    <td style="vertical-align:top;padding:8px 0;color:#d8d0c0;font-size:13.5px;line-height:1.55;">${desc}</td>
  </tr>`;
}

function welcomeHtml(firstName: string, signinUrl: string): string {
  const safeName = firstName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { background:#0a0a0a; color:#d8d0c0; font-family: 'Inter', system-ui, sans-serif; margin:0; padding:48px 24px; }
  .card { max-width:540px; margin:0 auto; background:#111111; border:1px solid #2a2a2a; padding:44px 36px; }
  .wordmark { color:#c9a84c; font-weight:500; letter-spacing:0.3em; font-size:13px; margin-bottom:32px; }
  h1 { color:#f5f0e8; font-family: 'Cormorant Garamond', Georgia, serif; font-weight:300; font-size:34px; line-height:1.1; margin:0 0 22px; }
  p { font-size:14px; line-height:1.7; color:#d8d0c0; margin:0 0 16px; }
  .lead-em { color:#f5f0e8; }
  .btn { display:inline-block; background:#c9a84c; color:#0a0a0a; padding:14px 30px; font-size:12px; letter-spacing:0.18em; text-transform:uppercase; text-decoration:none; margin:6px 0 18px; font-weight:500; }
  .muted { color:#888888; font-size:12px; margin-top:34px; line-height:1.6; }
  .signoff { color:#d8d0c0; font-size:14px; margin-top:30px; }
  table { width:100%; border-collapse:collapse; margin:6px 0 22px; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">MAIA</div>
    <h1>${safeName} —<br>you're in.</h1>
    <p>You've been invited as a <strong class="lead-em">founding member</strong> of Maia — the invite-only network for proven talent across every field. Most networks give you one thing. <strong class="lead-em">Maia gives you four:</strong></p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      ${vpRow("Talent", "Access to the proven few — the top of every field, in one place.")}
      ${vpRow("Spaces", "Private rooms that open worldwide, starting with Spring Place New York.")}
      ${vpRow("Support", "Your next venture, built here — through warm introductions, never cold.")}
      ${vpRow("Capital", "A merchant banking layer, coming soon — a network that backs its own.")}
    </table>
    <p>Click below to sign in — no password needed for your first visit.</p>
    <a class="btn" href="${signinUrl}">Sign in to Maia</a>
    <p>Once you're in, take a moment to complete your profile — your field, and what you're building or curious about next. The network is shaped by the people who show up early.</p>
    <p class="signoff">— The Maia team</p>
    <p class="muted">If the button doesn't work, paste this link into your browser:<br><span style="color:#666;word-break:break-all;">${signinUrl}</span></p>
    <p class="muted">Maia is invite-only. You're receiving this because you've been nominated as a member.</p>
  </div>
</body>
</html>`;
}
