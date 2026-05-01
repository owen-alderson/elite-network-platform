// invite-member — admin-only edge function that turns an approved
// application into a real member: invites the email via the auth admin API
// and upserts a public.members row keyed to the new auth.users.id.
//
// SECURITY: this function uses the service role key. It MUST verify the
// caller is on the admin allowlist before performing any privileged work.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SITE_URL = "https://owen-alderson.github.io/elite-network-platform";

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

  // 1. Authenticate caller via their JWT.
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
  let body: { application_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const applicationId = body.application_id;
  if (!applicationId) return json({ error: "application_id required" }, 400);

  // 3. Service-role client for privileged work.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4. Load the application.
  const { data: app, error: appErr } = await admin
    .from("applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (appErr) return json({ error: appErr.message }, 500);
  if (!app) return json({ error: "application not found" }, 404);
  if (app.created_member_id) {
    return json({ error: "member already created", member_id: app.created_member_id }, 409);
  }

  const email = (app.applicant_email || "").toLowerCase();
  if (!email) return json({ error: "application has no email" }, 400);

  // 5. Find existing auth user by email; otherwise invite.
  let authUserId: string;
  let invitedNow = false;

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return json({ error: "user lookup failed: " + listErr.message }, 500);
  const existing = list.users.find((u: any) => (u.email || "").toLowerCase() === email);

  if (existing) {
    authUserId = existing.id;
  } else {
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: SITE_URL + "/dashboard.html",
      data: { full_name: app.applicant_full_name },
    });
    if (inviteErr) return json({ error: "invite failed: " + inviteErr.message }, 500);
    if (!invited.user) return json({ error: "invite returned no user" }, 500);
    authUserId = invited.user.id;
    invitedNow = true;
  }

  // 6. Upsert member row keyed to auth.users.id.
  const loc = (app.applicant_location || "").split(",").map((s: string) => s.trim());
  const memberPayload: Record<string, unknown> = {
    id: authUserId,
    email,
    full_name: app.applicant_full_name,
    headline: app.applicant_headline || null,
    primary_pillar: app.applicant_pillar || null,
    location_city: loc[0] || null,
    location_country: loc[1] || null,
    linkedin_url: app.applicant_linkedin_url || null,
    website_url: app.applicant_website_url || null,
    achievements: Array.isArray(app.applicant_achievements) ? app.applicant_achievements : [],
    current_work: app.applicant_current_work || null,
    nominated_by: app.nominator_member_id || null,
  };

  const { data: member, error: memberErr } = await admin
    .from("members")
    .upsert(memberPayload, { onConflict: "id" })
    .select("id")
    .single();
  if (memberErr) return json({ error: "member create failed: " + memberErr.message }, 500);

  // 7. Stamp the application with the new member id.
  const { error: stampErr } = await admin
    .from("applications")
    .update({ created_member_id: member.id })
    .eq("id", applicationId);
  if (stampErr) return json({ error: "application update failed: " + stampErr.message }, 500);

  return json({ member_id: member.id, auth_user_id: authUserId, invited: invitedNow }, 200);
});
