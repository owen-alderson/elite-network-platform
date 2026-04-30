// auth.js — page-level auth guards.
// Requires supabase.js to be loaded first.
//
// Usage on a member page:
//   <script>aether.requireAuth();</script>
// Usage on an admin page:
//   <script>aether.requireAdmin();</script>
//
// Both functions return a Promise that resolves to the session (or null if
// the page is being redirected). They redirect via window.location.replace
// so the broken page never appears in the history.

(function () {
  if (!window.aether) {
    console.error('auth.js loaded before supabase.js — include supabase.js first');
    return;
  }

  function sameOriginUrl(raw) {
    if (!raw) return null;
    try {
      var url = new URL(raw, window.location.href);
      if (url.origin === window.location.origin) {
        return url.toString();
      }
    } catch (e) {
      // fall through
    }
    return null;
  }

  window.aether.requireAuth = async function () {
    var session = await window.aether.getSession();
    if (session) return session;

    var here = window.location.href;
    var loginUrl = new URL('login.html', window.location.href);
    loginUrl.searchParams.set('redirect', here);
    window.location.replace(loginUrl.toString());
    return null;
  };

  window.aether.requireAdmin = async function () {
    var session = await window.aether.requireAuth();
    if (!session) return null;
    var ok = await window.aether.isAdmin();
    if (!ok) {
      var dashboard = new URL('dashboard.html', window.location.href);
      window.location.replace(dashboard.toString());
      return null;
    }
    return session;
  };

  // Exported in case a page needs to validate a redirect param itself.
  window.aether.sameOriginUrl = sameOriginUrl;

  // Hide the "Request Access" CTA and route the AETHER wordmark to the
  // dashboard for logged-in members on any page that loads auth.js. The
  // public landing page (index.html) is jarring to land on once you're in.
  document.addEventListener('DOMContentLoaded', function () {
    window.aether.getSession().then(function (session) {
      if (!session) return;
      document.querySelectorAll('.nav-cta, .mobile-cta').forEach(function (el) {
        el.style.display = 'none';
      });
      // Public pages render the wordmark as <span> so it isn't clickable
      // pre-login. For signed-in members, swap each <span class="wordmark">
      // for a real anchor pointing at the dashboard.
      document.querySelectorAll('span.wordmark').forEach(function (span) {
        var a = document.createElement('a');
        a.className = span.className;
        a.href = 'dashboard.html';
        a.textContent = span.textContent;
        span.parentNode.replaceChild(a, span);
      });
      document.querySelectorAll('a.wordmark').forEach(function (el) {
        el.setAttribute('href', 'dashboard.html');
      });
    });
  });
})();
