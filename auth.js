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

  // Pages that must NOT trigger the set-password redirect, even when the
  // session lacks user_metadata.has_password. set-password.html is the
  // obvious one (would loop). login.html doesn't call requireAuth but
  // listed for completeness if the API is reused.
  var PASSWORD_GATE_EXEMPT_PATHS = ['set-password.html', 'login.html'];

  function isOnExemptPath() {
    var path = window.location.pathname || '';
    return PASSWORD_GATE_EXEMPT_PATHS.some(function (p) {
      return path.endsWith('/' + p) || path.endsWith(p);
    });
  }

  window.aether.requireAuth = async function () {
    var session = await window.aether.getSession();
    if (!session) {
      var here = window.location.href;
      var loginUrl = new URL('login.html', window.location.href);
      loginUrl.searchParams.set('redirect', here);
      window.location.replace(loginUrl.toString());
      return null;
    }

    // First-time-sign-in gate: until the member sets a password, all
    // requireAuth callers route them through set-password.html. The flag
    // lives in user_metadata.has_password and is flipped by set-password.js
    // via auth.updateUser({ data: { has_password: true } }).
    var meta = (session.user && session.user.user_metadata) || {};
    if (meta.has_password !== true && !isOnExemptPath()) {
      var setUrl = new URL('set-password.html', window.location.href);
      window.location.replace(setUrl.toString());
      return null;
    }

    return session;
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

      document.querySelectorAll('.nav-cta, .mobile-cta, .nav-signin, .mobile-signin').forEach(function (el) {
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
      injectMobileSignout();
      await injectMessagesLink(session.user.id);
      await injectAdminLink();
      subscribeToUnreadUpdates(session.user.id);
    });
  });

  // Listen for new messages + intro_requests in realtime so the nav badge
  // and any inbox-aware page can react without a page reload. RLS filters
  // the realtime payloads to rows the user is allowed to see.
  function subscribeToUnreadUpdates(userId) {
    var client = window.aether.client;
    return client
      .channel('inbox-realtime-' + userId)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        function (payload) {
          if (!payload.new || payload.new.sender_id === userId) return;
          refreshMessagesBadge(userId);
          window.dispatchEvent(new CustomEvent('aether:unread-changed'));
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'intro_requests' },
        function () {
          window.dispatchEvent(new CustomEvent('aether:unread-changed'));
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'intro_requests' },
        function () {
          window.dispatchEvent(new CustomEvent('aether:unread-changed'));
        })
      .subscribe();
  }

  async function refreshMessagesBadge(userId) {
    var n = await fetchUnreadMessageCount(userId);
    document.querySelectorAll('a[data-messages-link]').forEach(function (a) {
      var existing = a.querySelector('.nav-badge');
      if (n > 0) {
        if (existing) existing.textContent = n > 99 ? '99+' : String(n);
        else a.appendChild(buildNavBadge(n));
      } else if (existing) {
        existing.remove();
      }
    });
  }

  async function injectMessagesLink(userId) {
    var unreadCount = await fetchUnreadMessageCount(userId);

    document.querySelectorAll('.nav-links').forEach(function (group) {
      if (group.querySelector('a[data-messages-link]')) return;
      var a = document.createElement('a');
      a.href = 'messages.html';
      a.dataset.messagesLink = 'true';
      a.textContent = 'Messages';
      if (unreadCount > 0) a.appendChild(buildNavBadge(unreadCount));
      group.appendChild(a);
    });
    document.querySelectorAll('.mobile-menu').forEach(function (menu) {
      if (menu.querySelector('a[data-messages-link]')) return;
      var a = document.createElement('a');
      a.href = 'messages.html';
      a.dataset.messagesLink = 'true';
      a.textContent = 'Messages';
      if (unreadCount > 0) a.appendChild(buildNavBadge(unreadCount));
      var signout = menu.querySelector('.mobile-signout');
      if (signout) menu.insertBefore(a, signout);
      else menu.appendChild(a);
    });
  }

  async function fetchUnreadMessageCount(userId) {
    var res = await window.aether.client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .neq('sender_id', userId)
      .is('read_at', null);
    if (res.error) return 0;
    return res.count || 0;
  }

  function buildNavBadge(n) {
    var b = document.createElement('span');
    b.className = 'nav-badge';
    b.textContent = n > 99 ? '99+' : String(n);
    return b;
  }

  async function injectAdminLink() {
    var ok = await window.aether.isAdmin();
    if (!ok) return;

    // Desktop nav: append "Admin" to .nav-links if not already present.
    document.querySelectorAll('.nav-links').forEach(function (group) {
      if (group.querySelector('a[data-admin-link]')) return;
      // If the page is already admin.html, the nav-cta has been removed via
      // the apply-cta hide; we just want the link to read as the active item.
      var a = document.createElement('a');
      a.href = 'admin.html';
      a.dataset.adminLink = 'true';
      a.textContent = 'Admin';
      a.style.color = 'var(--gold)';
      group.appendChild(a);
    });

    // Mobile menu: same idea.
    document.querySelectorAll('.mobile-menu').forEach(function (menu) {
      if (menu.querySelector('a[data-admin-link]')) return;
      var a = document.createElement('a');
      a.href = 'admin.html';
      a.dataset.adminLink = 'true';
      a.textContent = 'Admin';
      a.style.color = 'var(--gold)';
      // Place above the sign-out link so the menu reads: pages → Admin → Sign out.
      var signout = menu.querySelector('.mobile-signout');
      if (signout) menu.insertBefore(a, signout);
      else menu.appendChild(a);
    });
  }

  function injectMobileSignout() {
    document.querySelectorAll('.mobile-menu').forEach(function (menu) {
      if (menu.querySelector('.mobile-signout')) return;
      var a = document.createElement('a');
      a.href = '#';
      a.className = 'mobile-signout';
      a.textContent = 'Sign out';
      a.addEventListener('click', async function (e) {
        e.preventDefault();
        try { await window.aether.signOut(); } catch (err) { /* fall through */ }
        window.location.replace('login.html');
      });
      menu.appendChild(a);
    });
  }

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
