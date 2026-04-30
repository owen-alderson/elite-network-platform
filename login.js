// login.js — magic-link login form behaviour.
// Requires supabase.js to be loaded first.

(function () {
  var form = document.getElementById('login-form');
  var emailInput = document.getElementById('login-email');
  var submit = document.getElementById('login-submit');
  var status = document.getElementById('login-status');

  // Where the magic link should land. Validate same-origin to avoid open
  // redirects in case a malicious actor crafts a login URL.
  function resolveRedirect() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('redirect');
    if (raw) {
      try {
        var url = new URL(raw, window.location.href);
        if (url.origin === window.location.origin) {
          return url.toString();
        }
      } catch (e) {
        // fall through
      }
    }
    return new URL('dashboard.html', window.location.href).toString();
  }

  var redirectTo = resolveRedirect();

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'login-status' + (kind ? ' is-' + kind : '');
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    setStatus('');

    var email = (emailInput.value || '').trim().toLowerCase();
    if (!email) {
      setStatus('Enter your email.', 'error');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending...';

    var res = await window.aether.signInWithMagicLink(email, redirectTo);
    if (res && res.error) {
      // Log the real reason for debugging — but don't surface it. Anti-enumeration:
      // a non-member should not be able to tell from the response whether
      // their email is registered.
      console.warn('Magic link request returned error:', res.error.message);
    }

    // Always show the same generic success message.
    setStatus('If you are a member, a sign-in link is on its way to your inbox.', 'success');
    submit.textContent = 'Sent';
    // Leave submit disabled so the user can't spam the form on this page.
  });
})();
