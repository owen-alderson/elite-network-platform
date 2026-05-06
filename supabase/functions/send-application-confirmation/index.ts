// send-application-confirmation — fires a "we received your application"
// email to the applicant via Resend. Idempotent on confirmation_sent_at,
// so apply.js can call this on submit without worrying about retries.
//
// Setup (one-time, by Owen):
//   1. Sign up for Resend (https://resend.com), grab an API key.
//   2. Verify a sending domain so Aether can send from hello@<domain>.
//   3. In the Supabase Dashboard → Edge Functions → secrets, set:
//        RESEND_API_KEY      <your_resend_key>
//        AETHER_FROM_EMAIL   "Aether <hello@yourdomain.com>"
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
const FROM_EMAIL = Deno.env.get("AETHER_FROM_EMAIL") || "Aether <onboarding@resend.dev>";

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
    .select("id, applicant_full_name, applicant_email, submission_type, confirmation_sent_at")
    .eq("id", applicationId)
    .maybeSingle();
  if (appErr) return json({ error: appErr.message }, 500);
  if (!app) return json({ error: "application not found" }, 404);
  if (app.confirmation_sent_at) {
    return json({ sent: false, reason: "already_sent" }, 200);
  }

  if (!RESEND_API_KEY) {
    console.warn("send-application-confirmation: RESEND_API_KEY not set; skipping send.");
    return json({ sent: false, reason: "resend_not_configured" }, 200);
  }

  const isNomination = app.submission_type === "nominator";
  const subject = isNomination
    ? "We received your nomination — Aether"
    : "We received your application — Aether";

  const html = `<!DOCTYPE html>
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
  a { color:#c9a84c; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">AETHER</div>
    <h1>${isNomination ? "Your nomination is in." : "Your application is in."}</h1>
    <p>${isNomination ? "Thanks" : "Thank you"}, ${escapeHtml(app.applicant_full_name?.split(" ")[0] || "there")}.</p>
    <p>${isNomination
      ? "We received your nomination and our review team will look at it within 5–10 business days. If your nominee meets the bar, we'll reach out to them directly with an invitation."
      : "We received your application. Our review team will read the one thing you've built — paired with what you're building or curious about next — against the global bar for your field. We typically respond within 5–10 business days. If you're approved, we'll send a sign-in link to this email."}</p>
    <p>Aether is invite-only and built around trust. We take our time — what we don't take is shortcuts.</p>
    <p class="muted">If you didn't ${isNomination ? "submit a nomination" : "apply"}, you can ignore this email. No action is required.</p>
  </div>
</body>
</html>`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [app.applicant_email],
      subject,
      html,
    }),
  });

  if (!resendRes.ok) {
    const text = await resendRes.text();
    console.error("Resend send failed:", resendRes.status, text);
    return json({ error: "resend_failed", status: resendRes.status, detail: text }, 500);
  }

  const stamp = await admin
    .from("applications")
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (stamp.error) {
    console.error("Failed to stamp confirmation_sent_at:", stamp.error);
    // Email already went out; don't fail the response.
  }

  return json({ sent: true }, 200);
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
