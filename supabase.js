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
    console.error('supabase-js library not loaded, include the unpkg script tag before supabase.js');
    return {};
  }

  // flowType: 'implicit' matches the project's Supabase Auth Dashboard
  // config. inviteUserByEmail() + recovery emails emit links that resolve
  // to {SITE}/dashboard.html#access_token=...&refresh_token=...&type=invite
  // (fragment). The PKCE flow looks for ?code=... in the query string;
  // when the client was set to 'pkce' getSession() returned null on first
  // land and auth.js bounced the user back to login.html on every invite
  // click, even though Supabase minted the session server-side (verified
  // in auth logs 2026-05-25 during David's test).
  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'implicit'
    }
  });

  // Defensive bootstrap: explicitly parse access_token / refresh_token from
  // the URL fragment and call setSession. Supabase's own detectSessionInUrl
  // proved unreliable in production during David's 2026-05-25 test — server
  // logs showed login succeeded and the browser landed on
  // /dashboard.html#access_token=... but getSession() kept returning null
  // and auth.js bounced the user to login.html. Parsing the hash ourselves
  // turns the implicit-flow callback into a no-op for the library and a
  // hard guarantee for us. Runs synchronously at client init so any
  // requireAuth() call sees the session immediately.
  var sessionFromHashPromise = null;
  (function bootstrapSessionFromHash() {
    if (typeof window === 'undefined' || !window.location || !window.location.hash) return;
    var hash = window.location.hash.replace(/^#/, '');

    // Failed verification (expired / already-used link) redirects here with
    // #error=access_denied&error_code=otp_expired. Before this was handled,
    // the fragment was silently dropped, requireAuth found no session and
    // bounced to login.html with zero explanation — the "circular login"
    // Melanie reported 7/5. Stash the code so login.js can explain and
    // offer a fresh link.
    if (hash.indexOf('error=') !== -1 && hash.indexOf('access_token=') === -1) {
      var errParams = new URLSearchParams(hash);
      var code = errParams.get('error_code') || errParams.get('error') || 'unknown';
      try { sessionStorage.setItem('maia_auth_error', code); } catch (e) { /* private mode */ }
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (e) { /* non-fatal */ }
      return;
    }

    if (hash.indexOf('access_token=') === -1) return;
    var params = new URLSearchParams(hash);
    var accessToken = params.get('access_token');
    var refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) return;
    sessionFromHashPromise = client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    }).then(function (res) {
      if (res.error) {
        console.error('Manual setSession from hash failed:', res.error);
      }
      // Strip the token fragment from the URL so a refresh doesn't re-run
      // this with a now-invalid token (and so it doesn't leak via referer).
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (e) { /* non-fatal */ }
    });
  })();

  // Hardcoded admin allowlist — phase 1 only.
  // The DB copy in supabase/schema.sql (is_admin()) is the source of truth;
  // this client copy only controls UI visibility. Always assume the client is hostile.
  // Phase 1: Owen is the sole admin.
  var ADMIN_EMAILS = [
    'owen.alderson@gmail.com'
  ];

  async function getSession() {
    // Wait for any in-flight manual hash bootstrap before asking the client
    // for the session, otherwise the first requireAuth() on an invite/magic
    // link landing can see null and bounce the user to login.html.
    if (sessionFromHashPromise) {
      try { await sessionFromHashPromise; } catch (e) { /* logged in bootstrap */ }
    }
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
  //
  // Focal point: avatar_url may carry a `#focus=X,Y` fragment (X,Y are
  // percentages 0–100). When present, we set object-position so the
  // square crop on both member cards AND the profile photo is centered
  // on that point. No fragment → CSS default applies.
  function fillAvatar(divEl, member) {
    if (!divEl) return;
    divEl.innerHTML = '';
    if (member && member.avatar_url) {
      var img = document.createElement('img');
      img.src = member.avatar_url;
      img.alt = member.full_name || '';
      img.className = 'avatar-img';
      var focus = parseAvatarFocus(member.avatar_url);
      if (focus) img.style.objectPosition = focus.x + '% ' + focus.y + '%';
      divEl.appendChild(img);
      divEl.classList.add('has-avatar');
    } else {
      var name = (member && member.full_name) ? member.full_name : '?';
      divEl.textContent = name.charAt(0).toUpperCase();
      divEl.classList.remove('has-avatar');
    }
  }

  function parseAvatarFocus(url) {
    if (!url) return null;
    var idx = url.indexOf('#focus=');
    if (idx === -1) return null;
    var parts = url.slice(idx + 7).split(',');
    if (parts.length !== 2) return null;
    var x = parseFloat(parts[0]);
    var y = parseFloat(parts[1]);
    if (isNaN(x) || isNaN(y)) return null;
    return {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y))
    };
  }

  // Strip any existing `#focus=…` and append the supplied {x,y}. Used by
  // the profile edit picker so the saved avatar_url carries the latest
  // focal point.
  function withAvatarFocus(url, focus) {
    if (!url) return url;
    var base = url.split('#focus=')[0];
    if (!focus) return base;
    var x = Math.round(Math.max(0, Math.min(100, focus.x)));
    var y = Math.round(Math.max(0, Math.min(100, focus.y)));
    return base + '#focus=' + x + ',' + y;
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

  // Security: return a URL string ONLY if it resolves to an http(s) URL,
  // otherwise null. Guards every place a member/applicant-supplied URL becomes
  // an <a href> (profile links, admin application LinkedIn) — a stored
  // `javascript:`/`data:`/`vbscript:` value would otherwise execute in a
  // viewer's (or the admin's) authenticated origin on click. Any input that
  // parses to a dangerous scheme is rejected on the first parse; the https://
  // prepend only runs when the input has no scheme at all, and can only ever
  // yield an http(s) URL — so there is no bypass.
  function safeExternalUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    var u = null;
    try { u = new URL(s); }
    catch (e) {
      try { u = new URL('https://' + s); } catch (e2) { return null; }
    }
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) return u.href;
    return null;
  }

  // Profile-completeness check. Used to gate intro-request actions: testers
  // with empty profiles shouldn't be reaching out to other members because
  // there's nothing for the target to evaluate. Threshold is the same scoring
  // surface used by the on-profile completeness banner (profile.js); keep
  // these in sync if you change one.
  // Lowered 4 → 2 on 2026-07-10 (Melanie: the old bar was 'a lot' and it was
  // unclear on mobile what was required). Any 2 of the 7 sections unlock intros.
  var PROFILE_INTRO_THRESHOLD = 2; // out of 7
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
    safeExternalUrl: safeExternalUrl,
    parseAvatarFocus: parseAvatarFocus,
    withAvatarFocus: withAvatarFocus,
    uploadAvatar: uploadAvatar,
    profileChecks: profileChecks,
    canIntroNow: canIntroNow,
    invalidateIntroCache: invalidateIntroCache
  };
})();
