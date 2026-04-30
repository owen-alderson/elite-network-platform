// supabase.js — Aether Supabase client + session helpers.
//
// Load order (in every page that needs auth or data):
//   <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
//   <script src="supabase.js"></script>
//
// SECURITY: only the PUBLISHABLE key is permitted in this file (formerly
// called the ANON key — same role, safe client-side, RLS-enforced).
// The SECRET / SERVICE ROLE key bypasses RLS and must NEVER appear in any
// client-side code, never be committed, never be deployed to GitHub Pages.
// See ARCHITECTURE.md.

window.aether = (function () {
  // Live Aether Supabase project. Both values are safe to commit — RLS in
  // supabase/schema.sql enforces row-level access.
  var SUPABASE_URL = 'https://emlresxklixzcsammste.supabase.co';
  var SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-uC-5RkQSuaNJAaKHqpw8g_5oAiuTFY';

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('supabase-js library not loaded — include the unpkg script tag before supabase.js');
    return {};
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  });

  // Hardcoded admin allowlist — phase 1 only.
  // The DB copy in supabase/schema.sql (is_admin()) is the source of truth;
  // this client copy only controls UI visibility. Always assume the client is hostile.
  // Phase 1: Owen is the sole admin.
  var ADMIN_EMAILS = [
    'owen.alderson@gmail.com'
  ];

  async function getSession() {
    var res = await client.auth.getSession();
    if (res.error) {
      console.error('getSession error:', res.error);
      return null;
    }
    return res.data.session;
  }

  async function getUser() {
    var session = await getSession();
    return session ? session.user : null;
  }

  function signInWithMagicLink(email, redirectTo) {
    return client.auth.signInWithOtp({
      email: email,
      options: {
        emailRedirectTo: redirectTo,
        // Critical: only invited users can sign in. Without this flag, anyone
        // with the login URL could create an account by entering any email.
        shouldCreateUser: false
      }
    });
  }

  function signOut() {
    return client.auth.signOut();
  }

  async function isAdmin() {
    var user = await getUser();
    if (!user || !user.email) return false;
    return ADMIN_EMAILS.indexOf(user.email.toLowerCase()) !== -1;
  }

  function onAuthStateChange(callback) {
    return client.auth.onAuthStateChange(callback);
  }

  return {
    client: client,
    ADMIN_EMAILS: ADMIN_EMAILS,
    getSession: getSession,
    getUser: getUser,
    signInWithMagicLink: signInWithMagicLink,
    signOut: signOut,
    isAdmin: isAdmin,
    onAuthStateChange: onAuthStateChange
  };
})();
