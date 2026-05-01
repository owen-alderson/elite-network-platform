// send-intro-notification — fires Resend emails when intro_requests
// transitions through key states. Called by the postgres trigger
// intro_requests_notify on UPDATE; idempotency is handled by only
// firing on specific state transitions inside the trigger.
//
// Events:
//   broker_assigned  → email the assigned broker. "X asked you to
//                      broker an intro to Y."
//   forwarded        → email the requester. "Z forwarded your request."
//
// Setup is shared with send-application-confirmation: relies on the
// same RESEND_API_KEY and AETHER_FROM_EMAIL secrets in the project.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("AETHER_FROM_EMAIL") || "Aether <onboarding@resend.dev>";
const SITE_URL = "https://owen-alderson.github.io/elite-network-platform";

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

type Event = "broker_assigned" | "forwarded" | "direct_received" | "direct_accepted";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { intro_id?: string; event?: Event };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const introId = body.intro_id;
  const event = body.event;
  if (!introId) return json({ error: "intro_id required" }, 400);
  if (!event) return json({ error: "event required" }, 400);

  if (!RESEND_API_KEY) {
    console.warn("send-intro-notification: RESEND_API_KEY not set; skipping send.");
    return json({ sent: false, reason: "resend_not_configured" }, 200);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: intro, error: introErr } = await admin
    .from("intro_requests")
    .select(
      "id, note, status, " +
      "requester:members!requester_id(id,full_name,email)," +
      "target:members!target_id(id,full_name,email)," +
      "broker:members!broker_id(id,full_name,email)"
    )
    .eq("id", introId)
    .maybeSingle();
  if (introErr) return json({ error: introErr.message }, 500);
  if (!intro) return json({ error: "intro not found" }, 404);

  let to: string | undefined;
  let subject = "";
  let html = "";

  const requesterName = intro.requester?.full_name || "A peer";
  const targetName = intro.target?.full_name || "another member";
  const brokerName = intro.broker?.full_name || "a member";

  if (event === "broker_assigned") {
    to = intro.broker?.email;
    subject = `${requesterName} asked you to broker an intro — Aether`;
    html = brokerEmailHtml(requesterName, targetName, intro.note);
  } else if (event === "forwarded") {
    to = intro.requester?.email;
    subject = `Your intro to ${targetName} was forwarded — Aether`;
    html = forwardedEmailHtml(targetName, brokerName);
  } else if (event === "direct_received") {
    to = intro.target?.email;
    subject = `${requesterName} would like to be introduced — Aether`;
    html = directReceivedEmailHtml(requesterName, intro.note);
  } else if (event === "direct_accepted") {
    to = intro.requester?.email;
    subject = `${targetName} accepted your introduction — Aether`;
    html = directAcceptedEmailHtml(targetName);
  } else {
    return json({ error: "unknown event" }, 400);
  }

  if (!to) return json({ error: "recipient email missing" }, 400);

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });

  if (!resendRes.ok) {
    const text = await resendRes.text();
    console.error("Resend send failed:", resendRes.status, text);
    return json({ error: "resend_failed", status: resendRes.status, detail: text }, 500);
  }

  return json({ sent: true, event }, 200);
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
  .quote { background:#0a0a0a; border-left:2px solid #8a6d2f; padding:14px 18px; font-size:13px; line-height:1.6; margin:14px 0; white-space:pre-wrap; font-style:italic; color:#d8d0c0; }
  .btn { display:inline-block; background:#c9a84c; color:#0a0a0a; padding:12px 24px; font-size:12px; letter-spacing:0.15em; text-transform:uppercase; text-decoration:none; margin-top:14px; }
  .muted { color:#888888; font-size:12px; margin-top:36px; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">AETHER</div>
    ${inner}
    <p class="muted">Aether is invite-only. You're receiving this because you're a member.</p>
  </div>
</body>
</html>`;
}

function brokerEmailHtml(requesterName: string, targetName: string, note: string | null): string {
  const safeNote = (note || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return shellHtml(`
    <h1>You've been asked to broker an intro.</h1>
    <p><strong style="color:#f5f0e8;">${escapeHtml(requesterName)}</strong> would like an introduction to <strong style="color:#f5f0e8;">${escapeHtml(targetName)}</strong>, and the admin team thinks you're the right person to make it happen.</p>
    <p>Their note:</p>
    <div class="quote">${safeNote}</div>
    <p>Make the introduction off-platform (email, message, in person), then mark it forwarded on your dashboard.</p>
    <a class="btn" href="${SITE_URL}/dashboard.html">Open Aether</a>
  `);
}

function forwardedEmailHtml(targetName: string, brokerName: string): string {
  return shellHtml(`
    <h1>Your introduction is on its way.</h1>
    <p><strong style="color:#f5f0e8;">${escapeHtml(brokerName)}</strong> has made the introduction to <strong style="color:#f5f0e8;">${escapeHtml(targetName)}</strong>. Watch for an email or message — the conversation continues off-platform.</p>
    <p>Once you've connected, mark the intro as accepted on your dashboard so it shows up in your network.</p>
    <a class="btn" href="${SITE_URL}/dashboard.html">Open Aether</a>
  `);
}

function directReceivedEmailHtml(requesterName: string, note: string | null): string {
  const safeNote = (note || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return shellHtml(`
    <h1>${escapeHtml(requesterName)} would like to meet you.</h1>
    <p>You don't have a mutual connection on Aether yet, so this request is coming straight to you. They wrote:</p>
    <div class="quote">${safeNote}</div>
    <p>Open Aether to see their profile and accept or decline. If you accept, a private conversation opens between the two of you.</p>
    <a class="btn" href="${SITE_URL}/dashboard.html">Open Aether</a>
  `);
}

function directAcceptedEmailHtml(targetName: string): string {
  return shellHtml(`
    <h1>${escapeHtml(targetName)} accepted your introduction.</h1>
    <p>A private conversation has opened between the two of you. Pick up where the request left off — your note is already there as the first message.</p>
    <a class="btn" href="${SITE_URL}/dashboard.html">Open Aether</a>
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
