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

  // Auth-aware UI: every page that loads auth.js gets a consistent visible
  // signal of whether the visitor is signed in.
  //   • Logged out: "Request Access" CTA visible, wordmark non-interactive
  //     on public pages, no session chip.
  //   • Logged in: CTA hidden, wordmark routes to dashboard, a session chip
  //     [name · Sign out] is injected into the nav.
  document.addEventListener('DOMContentLoaded', function () {
    window.aether.getSession().then(async function (session) {
      if (!session) return;

      document.querySelectorAll('.nav-cta, .mobile-cta').forEach(function (el) {
        el.style.display = 'none';
      });

      // Wordmark: span → anchor (public pages); existing anchors get rewritten.
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

      await injectNavSession(session);
    });
  });

  async function injectNavSession(session) {
    var navInner = document.querySelector('.nav .nav-inner');
    if (!navInner) return;
    if (navInner.querySelector('.nav-session')) return;

    // Best-effort first-name: members.full_name if available, else email local part.
    var firstName = (session.user.email || 'M').split('@')[0].split('.')[0];
    firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
    try {
      var res = await window.aether.client
        .from('members')
        .select('full_name')
        .eq('id', session.user.id)
        .maybeSingle();
      if (res && res.data && res.data.full_name) {
        firstName = res.data.full_name.split(' ')[0];
      }
    } catch (e) { /* swallow — placeholder name is fine */ }

    var existingMember = navInner.querySelector('.nav-member');
    if (existingMember) {
      // Dashboard already shows avatar + name (and toggles the inbox). Just
      // append a sign-out link so the dashboard nav also offers logout.
      if (!existingMember.querySelector('.nav-signout')) {
        var sep1 = document.createElement('span');
        sep1.className = 'nav-session-sep';
        sep1.textContent = '·';
        existingMember.appendChild(sep1);
        existingMember.appendChild(buildSignoutLink());
      }
      return;
    }

    var initial = firstName.charAt(0).toUpperCase();

    var wrap = document.createElement('div');
    wrap.className = 'nav-session';

    var avatar = document.createElement('div');
    avatar.className = 'nav-avatar';
    avatar.textContent = initial;
    wrap.appendChild(avatar);

    var name = document.createElement('span');
    name.className = 'nav-session-name';
    name.textContent = firstName;
    wrap.appendChild(name);

    var sep = document.createElement('span');
    sep.className = 'nav-session-sep';
    sep.textContent = '·';
    wrap.appendChild(sep);

    wrap.appendChild(buildSignoutLink());

    // Insert just before the hamburger if present, else append to nav-inner.
    var hamburger = navInner.querySelector('.hamburger');
    if (hamburger) {
      navInner.insertBefore(wrap, hamburger);
    } else {
      navInner.appendChild(wrap);
    }
  }

  function buildSignoutLink() {
    var a = document.createElement('a');
    a.href = '#';
    a.className = 'nav-signout';
    a.textContent = 'Sign out';
    a.addEventListener('click', async function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { await window.aether.signOut(); } catch (err) { /* fall through */ }
      window.location.replace('login.html');
    });
    return a;
  }
})();
