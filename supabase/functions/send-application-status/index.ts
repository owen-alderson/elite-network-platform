// send-application-status — emails the applicant when admin sets their
// application to 'rejected' or 'needs_more_info'. Approval is handled
// separately by the invite-member function (which sends a Supabase auth
// invite, not a Resend email).
//
// Called by the postgres trigger applications_send_status_change on
// UPDATE. Idempotent on a stamp column status_email_sent_at so a double-
// fire doesn't double-email.
//
// Requires the same RESEND_API_KEY + MAIA_FROM_EMAIL secrets as the
// other email functions. Graceful no-op without the key.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("MAIA_FROM_EMAIL") || "Maia <onboarding@resend.dev>";

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

  let body: { application_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const applicationId = body.application_id;
  if (!applicationId) return json({ error: "application_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: app, error: appErr } = await admin
    .from("applications")
    .select("id, applicant_full_name, applicant_email, status, reviewer_notes, status_email_sent_at")
    .eq("id", applicationId)
    .maybeSingle();
  if (appErr) return json({ error: appErr.message }, 500);
  if (!app) return json({ error: "application not found" }, 404);

  if (!['rejected', 'needs_more_info'].includes(app.status)) {
    return json({ sent: false, reason: "status_not_emailable", status: app.status }, 200);
  }
  if (app.status_email_sent_at) {
    return json({ sent: false, reason: "already_sent" }, 200);
  }

  if (!RESEND_API_KEY) {
    console.warn("send-application-status: RESEND_API_KEY not set; skipping send.");
    return json({ sent: false, reason: "resend_not_configured" }, 200);
  }

  const firstName = (app.applicant_full_name || "there").split(" ")[0];
  let subject = "";
  let html = "";

  if (app.status === "needs_more_info") {
    subject = "We need a bit more information — Maia";
    html = needsMoreInfoHtml(firstName, app.reviewer_notes);
  } else if (app.status === "rejected") {
    subject = "An update on your Maia application";
    html = rejectedHtml(firstName, app.reviewer_notes);
  }

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [app.applicant_email], subject, html }),
  });

  if (!resendRes.ok) {
    const text = await resendRes.text();
    console.error("Resend send failed:", resendRes.status, text);
    return json({ error: "resend_failed", status: resendRes.status, detail: text }, 500);
  }

  await admin
    .from("applications")
    .update({ status_email_sent_at: new Date().toISOString() })
    .eq("id", applicationId);

  return json({ sent: true, status: app.status }, 200);
});

function shellHtml(inner: string): string {
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
  .quote { background:#0a0a0a; border-left:2px solid #8a6d2f; padding:14px 18px; font-size:13px; line-height:1.6; margin:14px 0; white-space:pre-wrap; color:#d8d0c0; }
  .muted { color:#888888; font-size:12px; margin-top:36px; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">MAIA</div>
    ${inner}
    <p class="muted">If you didn't apply to Maia, you can ignore this email.</p>
  </div>
</body>
</html>`;
}

function needsMoreInfoHtml(firstName: string, reviewerNotes: string | null): string {
  const notesBlock = reviewerNotes
    ? `<p>Reviewer's note:</p><div class="quote">${escapeHtml(reviewerNotes)}</div>`
    : '';
  return shellHtml(`
    <h1>We're considering your application — but need a bit more.</h1>
    <p>Thank you, ${escapeHtml(firstName)}. Our review team has read your submission and would like additional context before making a decision.</p>
    ${notesBlock}
    <p>Reply to this email with the requested information and we'll resume review.</p>
  `);
}

function rejectedHtml(firstName: string, reviewerNotes: string | null): string {
  const notesBlock = reviewerNotes
    ? `<p>Reviewer's note:</p><div class="quote">${escapeHtml(reviewerNotes)}</div>`
    : '';
  return shellHtml(`
    <h1>An update on your application.</h1>
    <p>Thank you for applying, ${escapeHtml(firstName)}. After careful review, we won't be moving forward with your membership at this time.</p>
    ${notesBlock}
    <p>Maia maintains a deliberately narrow standard, and a decision today doesn't reflect on what comes next. Many candidates apply more than once as their work develops.</p>
  `);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
