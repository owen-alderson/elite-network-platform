// send-application-confirmation — fires when a row is INSERTed into
// public.applications (postgres trigger applications_send_confirmation),
// and is also invoked directly by the admin queue.
//
// Trigger path (body: { application_id }):
//   • applicant — one email to applicant_email confirming receipt.
//     Stamps confirmation_sent_at.
//   • nominator — ONE email to nominator_email confirming the nomination
//     landed. Stamps confirmation_sent_at. The nominee is NOT emailed here.
//
// Admin path (body: { application_id, action: "nominee_invite" }):
//   • Sends the nominee the "complete your application" email with their
//     unique apply.html?code=... link. Triggered when an admin chooses to
//     request a nominee's full application. Stamps nominee_invite_sent_at.
//     Always sends, so an admin can re-send a lost invite.
//
// Setup (one-time, by Owen):
//   1. Sign up for Resend (https://resend.com), grab an API key.
//   2. Verify a sending domain so Maia can send from hello@<domain>.
//   3. In the Supabase Dashboard → Edge Functions → secrets, set:
//        RESEND_API_KEY      <your_resend_key>
//        MAIA_FROM_EMAIL   "Maia <hello@yourdomain.com>"
//   4. Redeploy this function (or restart it) so it picks up the secret.
//
// If RESEND_API_KEY is missing, the function logs a warning and returns
// 200 with sent:false — so the apply form keeps working before email is
// wired up.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("MAIA_FROM_EMAIL") || "Maia <onboarding@resend.dev>";

// Public site URL — used to build the nominee invite link. Mirrors the
// constant in invite-member/index.ts.
const SITE_URL = "https://maiacircle.com";

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

  let body: { application_id?: string; action?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const applicationId = body.application_id;
  if (!applicationId) return json({ error: "application_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: app, error: appErr } = await admin
    .from("applications")
    .select("id, applicant_full_name, applicant_email, applicant_current_work, submission_type, nominator_full_name, nominator_email, nominator_note, nomination_code, confirmation_sent_at, nominee_invite_sent_at")
    .eq("id", applicationId)
    .maybeSingle();
  if (appErr) return json({ error: appErr.message }, 500);
  if (!app) return json({ error: "application not found" }, 404);

  if (!RESEND_API_KEY) {
    console.warn("send-application-confirmation: RESEND_API_KEY not set; skipping send.");
    return json({ sent: false, reason: "resend_not_configured" }, 200);
  }

  // Admin-triggered: send the nominee their application link. A deliberate
  // admin action, so it always sends (an admin may re-send a lost invite).
  if (body.action === "nominee_invite") {
    return await sendNomineeInvite(admin, app);
  }

  // Trigger path (fires on INSERT). Each branch stamps its own _sent_at
  // column so trigger retries / replays are no-ops.
  if (app.submission_type === "applicant") {
    return await handleApplicant(admin, app);
  } else if (app.submission_type === "nominator") {
    return await sendNominatorConfirmation(admin, app);
  } else {
    return json({ error: "unknown submission_type: " + app.submission_type }, 400);
  }
});

// ── Applicant: one email, "we received your application" ────────────
async function handleApplicant(admin: any, app: any): Promise<Response> {
  if (app.confirmation_sent_at) {
    return json({ sent: false, reason: "already_sent" }, 200);
  }

  const firstName = (app.applicant_full_name?.split(" ")[0]) || "there";
  const subject = "We received your application — Maia";
  const html = applicantConfirmationHtml(firstName);

  const ok = await sendEmail({ to: [app.applicant_email], subject, html });
  if (!ok.ok) return json({ error: "resend_failed", detail: ok.detail, status: ok.status }, 500);

  await admin
    .from("applications")
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", app.id);

  return json({ sent: true, kind: "applicant_confirmation" }, 200);
}

// ── Nominator confirmation — "we received your nomination" ──────────
// Fires on INSERT of a nominator row. Confirms the vouch landed. Does NOT
// email the nominee — that is admin-triggered (sendNomineeInvite).
async function sendNominatorConfirmation(admin: any, app: any): Promise<Response> {
  if (app.confirmation_sent_at) {
    return json({ sent: false, reason: "already_sent" }, 200);
  }
  if (!app.nominator_email) {
    console.warn("Nomination", app.id, "has no nominator_email; skipping confirmation.");
    return json({ sent: false, reason: "no_nominator_email" }, 200);
  }

  const nominatorFirst = (app.nominator_full_name?.split(" ")[0]) || "there";
  const nomineeName = app.applicant_full_name || "your nominee";
  const ok = await sendEmail({
    to: [app.nominator_email],
    subject: "We received your nomination — Maia",
    html: nominatorConfirmationHtml(nominatorFirst, nomineeName),
  });
  if (!ok.ok) return json({ error: "resend_failed", detail: ok.detail, status: ok.status }, 500);

  await admin
    .from("applications")
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", app.id);

  return json({ sent: true, kind: "nominator_confirmation" }, 200);
}

// ── Nominee invite — admin-triggered "complete your application" ────
// Sent when an admin requests the nominee's full application. Always
// sends (re-send safe). Stamps nominee_invite_sent_at for admin-queue UI.
async function sendNomineeInvite(admin: any, app: any): Promise<Response> {
  if (app.submission_type !== "nominator") {
    return json({ error: "not a nomination" }, 400);
  }
  if (!app.applicant_email || !app.nomination_code) {
    return json({ error: "nomination missing nominee email or code" }, 400);
  }

  const nomineeFirst = (app.applicant_full_name?.split(" ")[0]) || "there";
  const nominatorName = app.nominator_full_name || "A Maia member";
  const inviteUrl = SITE_URL + "/apply.html?code=" + encodeURIComponent(app.nomination_code) +
    "&email=" + encodeURIComponent(app.applicant_email);
  const ok = await sendEmail({
    to: [app.applicant_email],
    subject: nominatorName + " nominated you for Maia",
    html: nomineeInviteHtml(nomineeFirst, nominatorName, app.nominator_note, inviteUrl),
  });
  if (!ok.ok) return json({ error: "resend_failed", detail: ok.detail, status: ok.status }, 500);

  await admin
    .from("applications")
    .update({ nominee_invite_sent_at: new Date().toISOString() })
    .eq("id", app.id);

  return json({ sent: true, kind: "nominee_invite" }, 200);
}

// ── Resend wrapper ──────────────────────────────────────────────────
async function sendEmail(args: { to: string[]; subject: string; html: string }): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: args.to, subject: args.subject, html: args.html }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, status: res.status, detail: text };
}

// ── Branded HTML email shells ────────────────────────────────────────
function shell(inner: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { background:#0a0a0a; color:#d8d0c0; font-family: 'Inter', system-ui, sans-serif; margin:0; padding:48px 24px; }
  .card { max-width:520px; margin:0 auto; background:#111111; border:1px solid #2a2a2a; padding:40px 36px; }
  .wordmark { color:#c9a84c; font-weight:500; letter-spacing:0.3em; font-size:13px; margin-bottom:32px; }
  h1 { color:#f5f0e8; font-family: 'Cormorant Garamond', Georgia, serif; font-weight:300; font-size:32px; line-height:1.15; margin:0 0 18px; }
  p { font-size:14px; line-height:1.7; color:#d8d0c0; margin:0 0 14px; }
  .muted { color:#888888; font-size:12px; margin-top:36px; }
  .quote { background:#0a0a0a; border-left:2px solid #8a6d2f; padding:14px 18px; font-size:13px; line-height:1.6; margin:14px 0; white-space:pre-wrap; color:#d8d0c0; }
  .cta-wrap { margin: 28px 0 24px; }
  .cta { display:inline-block; background:#c9a84c; color:#0a0a0a !important; text-decoration:none; font-weight:500; letter-spacing:0.05em; padding:14px 30px; border-radius:2px; font-size:13px; }
  .fallback { word-break:break-all; font-size:11px; color:#888888; margin-top:6px; line-height:1.6; }
  a { color:#c9a84c; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">MAIA</div>
    ${inner}
  </div>
</body>
</html>`;
}

function applicantConfirmationHtml(firstName: string): string {
  return shell(`
    <h1>Your application is in.</h1>
    <p>Thank you, ${escapeHtml(firstName)}.</p>
    <p>We received your application. Our review team will read the one thing you've built — paired with what you're building or curious about next — against the global bar for your field. We typically respond within 5–10 business days. If you're approved, we'll send a sign-in link to this email.</p>
    <p>Maia is invite-only and built around trust. We take our time — what we don't take is shortcuts.</p>
    <p class="muted">If you didn't apply, you can ignore this email. No action is required.</p>
  `);
}

function nominatorConfirmationHtml(nominatorFirst: string, nomineeName: string): string {
  return shell(`
    <h1>Your nomination is in.</h1>
    <p>Thanks, ${escapeHtml(nominatorFirst)}.</p>
    <p>We received your nomination of ${escapeHtml(nomineeName)}. Our review team will weigh your endorsement against the global bar for their field. If it's a fit, we'll invite them to complete a full application.</p>
    <p>You'll hear from us when there's a decision. Thank you for helping keep the network exceptional.</p>
    <p class="muted">If you didn't submit a nomination, you can ignore this email.</p>
  `);
}

function nomineeInviteHtml(nomineeFirst: string, nominatorName: string, nominatorNote: string | null, inviteUrl: string): string {
  const noteBlock = nominatorNote
    ? `<p>What ${escapeHtml(nominatorName)} said about you:</p><div class="quote">${escapeHtml(nominatorNote)}</div>`
    : '';
  return shell(`
    <h1>You've been nominated for Maia.</h1>
    <p>Hi ${escapeHtml(nomineeFirst)} —</p>
    <p><strong>${escapeHtml(nominatorName)}</strong> nominated you for membership at Maia — an invite-only network for proven talent in one field, and the adjacent ventures they're already building, or about to discover.</p>
    ${noteBlock}
    <p>Click below to complete your application. It takes about 8 minutes — we ask about the one thing you've built, what you're building or curious about next, and the credentials behind both.</p>
    <div class="cta-wrap">
      <a class="cta" href="${escapeHtml(inviteUrl)}">Complete your application</a>
    </div>
    <p class="fallback">Or paste this into your browser:<br />${escapeHtml(inviteUrl)}</p>
    <p class="muted">This link is unique to you. Maia is invite-only — please don't forward it.</p>
  `);
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
