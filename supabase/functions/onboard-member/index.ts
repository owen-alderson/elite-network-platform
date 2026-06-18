// onboard-member — ADMIN-ONLY. Onboards a brand-new founding member from
// just a name + email: someone met off-platform (a call, a warm intro) who
// never went through the apply form. In one step it:
//   1. creates the auth user if missing (confirmed + passwordless),
//   2. upserts the public.members row keyed to that auth id,
//   3. emails the branded magic-link welcome (identical to send-member-invite).
//
// Why this exists: send-member-invite only reaches members who ALREADY exist
// (the seeded founding members); invite-member only works from an approved
// application. Neither can onboard an ad-hoc person, so admin.html had no
// "add a member by email" path. This closes that gap.
//
// SECURITY: uses the service role key, so it MUST verify the caller is on the
// admin allowlist before doing anything (mirrors invite-member /
// send-member-invite). Inputs are validated + normalised server-side.

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

// Mirrors ALL_PILLARS in admin.js. Any value not on this list is dropped to
// null so a bad client can't write arbitrary pillar strings.
const ALLOWED_PILLARS = [
  "beauty", "entertainment", "entrepreneurship", "fashion", "finance",
  "hospitality", "investor", "music", "sport", "wellness",
];

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

  if (!RESEND_API_KEY) return json({ error: "resend_not_configured" }, 500);

  // 2. Validate + normalise input.
  let body: { email?: string; full_name?: string; primary_pillar?: string; headline?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const email = (body.email || "").trim().toLowerCase();
  const fullName = (body.full_name || "").trim();
  if (!fullName) return json({ error: "name_required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);

  const pillar = ALLOWED_PILLARS.includes((body.primary_pillar || "").trim())
    ? (body.primary_pillar as string).trim()
    : null;
  const headline = (body.headline || "").trim() || null;
  const firstName = fullName.split(/\s+/)[0];

  // 3. Service-role client for privileged work.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4. Guard: refuse if this email is already a member. Re-inviting an
  //    existing member is what "Send sign-in invite" on their card is for.
  const { data: existingMember, error: existErr } = await admin
    .from("members")
    .select("id, status")
    .eq("email", email)
    .maybeSingle();
  if (existErr) return json({ error: existErr.message }, 500);
  if (existingMember) {
    return json({ error: "already_member", member_id: existingMember.id, status: existingMember.status }, 409);
  }

  // 5. Find existing auth user by email; otherwise create a confirmed,
  //    passwordless user (createUser sends NO email — we send our own).
  let authUserId: string;
  let createdNow = false;
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return json({ error: "user lookup failed: " + listErr.message }, 500);
  const existing = list.users.find((u: any) => (u.email || "").toLowerCase() === email);
  if (existing) {
    authUserId = existing.id;
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr) return json({ error: "create failed: " + createErr.message }, 500);
    if (!created.user) return json({ error: "create returned no user" }, 500);
    authUserId = created.user.id;
    createdNow = true;
  }

  // 6. Upsert the member row keyed to auth.users.id. Minimal by design —
  //    the member completes the rest of their profile on first sign-in.
  const memberPayload: Record<string, unknown> = {
    id: authUserId,
    email,
    full_name: fullName,
  };
  if (pillar) memberPayload.primary_pillar = pillar;
  if (headline) memberPayload.headline = headline;

  const { data: member, error: memberErr } = await admin
    .from("members")
    .upsert(memberPayload, { onConflict: "id" })
    .select("id")
    .single();
  if (memberErr) return json({ error: "member create failed: " + memberErr.message }, 500);

  // 7. Magic link — one-time sign-in URL embedded in the email.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: SITE_URL + "/dashboard.html" },
  });
  if (linkErr) return json({ error: "link_failed: " + linkErr.message }, 500);
  const actionLink = linkData?.properties?.action_link;
  if (!actionLink) return json({ error: "link_missing" }, 500);

  // 8. Send the branded welcome email (identical to send-member-invite v2).
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

  return json({ sent: true, email, member_id: member.id, created: createdNow }, 200);
});

// One value-prop row: gold uppercase label on the left, plain-language payoff
// on the right. Four of these carry the homepage's four pillars into the
// welcome email so the promise reads the same everywhere.
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
