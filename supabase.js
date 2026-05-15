// supabase.js — Maia Supabase client + session helpers.
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

window.maia = (function () {
  // Live Maia Supabase project. Both values are safe to commit — RLS in
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

  // Fill a circular avatar element with either an <img> (when the member
  // has an avatar_url) or the first letter of their name as a fallback.
  // Used everywhere a member's face is shown so initial → photo flips
  // happen consistently.
  function fillAvatar(divEl, member) {
    if (!divEl) return;
    divEl.innerHTML = '';
    if (member && member.avatar_url) {
      var img = document.createElement('img');
      img.src = member.avatar_url;
      img.alt = member.full_name || '';
      img.className = 'avatar-img';
      divEl.appendChild(img);
      divEl.classList.add('has-avatar');
    } else {
      var name = (member && member.full_name) ? member.full_name : '?';
      divEl.textContent = name.charAt(0).toUpperCase();
      divEl.classList.remove('has-avatar');
    }
  }

  // Upload a File to the avatars bucket under the user's own folder, then
  // update members.avatar_url. Returns the public URL on success or null
  // on error (caller logs / surfaces).
  async function uploadAvatar(userId, file) {
    if (!userId || !file) return null;
    var ext = (file.name.split('.').pop() || 'png').toLowerCase();
    var path = userId + '/' + Date.now() + '.' + ext;
    var up = await client.storage.from('avatars').upload(path, file, {
      cacheControl: '3600',
      upsert: false
    });
    if (up.error) {
      console.error('avatar upload error:', up.error);
      return null;
    }
    var pub = client.storage.from('avatars').getPublicUrl(path);
    var url = pub && pub.data ? pub.data.publicUrl : null;
    if (!url) return null;
    var update = await client.from('members').update({ avatar_url: url }).eq('id', userId);
    if (update.error) {
      console.error('avatar_url update error:', update.error);
      return null;
    }
    return url;
  }

  // Profile-completeness check. Used to gate intro-request actions: testers
  // with empty profiles shouldn't be reaching out to other members because
  // there's nothing for the target to evaluate. Threshold is the same scoring
  // surface used by the on-profile completeness banner (profile.js); keep
  // these in sync if you change one.
  var PROFILE_INTRO_THRESHOLD = 4; // out of 7
  function profileChecks(m) {
    if (!m) return { score: 0, total: 7, ready: false };
    var checks = [
      !!m.avatar_url,
      !!(m.bio && String(m.bio).trim()),
      !!(m.headline && String(m.headline).trim()),
      !!(m.location_city || m.location_country),
      !!(m.current_work && String(m.current_work).trim()),
      !!(m.linkedin_url || m.instagram_handle || m.website_url),
      Array.isArray(m.achievements) && m.achievements.length > 0
    ];
    var score = checks.filter(Boolean).length;
    return { score: score, total: 7, ready: score >= PROFILE_INTRO_THRESHOLD };
  }

  // Cached "can I make intros?" check for the current user. Pages that gate
  // intro CTAs call this once and reuse the result. Invalidated on profile save.
  var canIntroCache = null;
  async function canIntroNow() {
    if (canIntroCache !== null) return canIntroCache;
    var user = await getUser();
    if (!user) return (canIntroCache = { ready: false, score: 0, total: 7 });
    var res = await client.from('members')
      .select('avatar_url,bio,headline,location_city,location_country,current_work,linkedin_url,instagram_handle,website_url,achievements')
      .eq('id', user.id)
      .maybeSingle();
    if (res.error || !res.data) return (canIntroCache = { ready: false, score: 0, total: 7 });
    canIntroCache = profileChecks(res.data);
    return canIntroCache;
  }
  function invalidateIntroCache() { canIntroCache = null; }

  return {
    client: client,
    ADMIN_EMAILS: ADMIN_EMAILS,
    getSession: getSession,
    getUser: getUser,
    signInWithMagicLink: signInWithMagicLink,
    signOut: signOut,
    isAdmin: isAdmin,
    onAuthStateChange: onAuthStateChange,
    fillAvatar: fillAvatar,
    uploadAvatar: uploadAvatar,
    profileChecks: profileChecks,
    canIntroNow: canIntroNow,
    invalidateIntroCache: invalidateIntroCache
  };
})();
