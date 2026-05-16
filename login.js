// login.js — sign-in form behaviour.
// Three auth paths:
//   1. Email + password → signInWithPassword (returning members)
//   2. Email only (no password) → signInWithOtp (magic link, first sign-in)
//   3. "Forgot password?" → resetPasswordForEmail (recovery flow)
//
// First-time members never have a password set, so they leave the password
// blank and get a magic link. After landing on dashboard, auth.js detects
// user_metadata.has_password !== true and redirects them to set-password.html.
// Once they set one, all subsequent sign-ins are password-only.
//
// The 2/hour Supabase Auth SMTP rate limit only matters for paths 2 + 3 —
// password sign-in (path 1) is the steady-state flow and uses zero email.
//
// Requires supabase.js to be loaded first.

(function () {
  var form = document.getElementById('login-form');
  var emailInput = document.getElementById('login-email');
  var passwordInput = document.getElementById('login-password');
  var submit = document.getElementById('login-submit');
  var status = document.getElementById('login-status');
  var magicLinkBtn = document.getElementById('login-magic-link');
  var forgotBtn = document.getElementById('login-forgot');

  // Where the post-sign-in redirect should land. Validate same-origin to
  // avoid open-redirect abuse.
  function resolveRedirect() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('redirect');
    if (raw) {
      try {
        var url = new URL(raw, window.location.href);
        if (url.origin === window.location.origin) {
          return url.toString();
        }
      } catch (e) { /* fall through */ }
    }
    return new URL('dashboard.html', window.location.href).toString();
  }

  var redirectTo = resolveRedirect();

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'login-status' + (kind ? ' is-' + kind : '');
  }

  function getEmail() {
    return (emailInput.value || '').trim().toLowerCase();
  }

  // ── Path 1: password sign-in ────────────────────────────────
  async function signInWithPassword(email, password) {
    submit.disabled = true;
    submit.textContent = 'Signing in...';
    setStatus('');

    var res = await window.maia.client.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (res.error) {
      console.warn('Password sign-in error:', res.error.message);
      // Generic message — doesn't leak whether the email exists or whether
      // the password is wrong vs. unset. First-time members will see this
      // if they accidentally typed something in the password field.
      setStatus("Wrong email or password — or you haven't set one yet. Leave password blank to get a magic link.", 'error');
      submit.disabled = false;
      submit.textContent = 'Sign in';
      return;
    }

    // Success — auth.js will route based on user_metadata.has_password.
    // We hop to the redirect target; if has_password is missing, auth.js
    // bounces them to set-password.html.
    window.location.replace(redirectTo);
  }

  // ── Path 2: magic-link sign-in (email-only, first time / fallback) ──
  async function signInWithMagicLink(email) {
    submit.disabled = true;
    submit.textContent = 'Sending...';
    setStatus('');

    var res = await window.maia.signInWithMagicLink(email, redirectTo);
    if (res && res.error) {
      console.warn('Magic-link request error:', res.error.message);
    }

    // Always show the same generic message — anti-enumeration.
    setStatus('If you are a member, a sign-in link is on its way to your inbox.', 'success');
    submit.textContent = 'Sent';
    // Leave submit disabled.
  }

  // ── Path 3: forgot-password recovery ────────────────────────
  async function sendPasswordReset(email) {
    setStatus('');

    var setPasswordUrl = new URL('set-password.html', window.location.href).toString();
    var res = await window.maia.client.auth.resetPasswordForEmail(email, {
      redirectTo: setPasswordUrl
    });

    if (res && res.error) {
      console.warn('Password-reset request error:', res.error.message);
    }

    setStatus('If you have a Maia account, a password-reset link is on its way to your inbox.', 'success');
  }

  // ── Form submit: branches on whether the password field is filled ──
  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    var email = getEmail();
    var password = passwordInput.value;

    if (!email) {
      setStatus('Enter your email.', 'error');
      return;
    }

    if (password) {
      await signInWithPassword(email, password);
    } else {
      await signInWithMagicLink(email);
    }
  });

  // ── "Send me a magic link instead" — explicit override ──────
  magicLinkBtn.addEventListener('click', async function (event) {
    event.preventDefault();
    var email = getEmail();
    if (!email) {
      setStatus('Enter your email first.', 'error');
      return;
    }
    await signInWithMagicLink(email);
  });

  // ── "Forgot password?" — separate recovery flow ─────────────
  forgotBtn.addEventListener('click', async function (event) {
    event.preventDefault();
    var email = getEmail();
    if (!email) {
      setStatus('Enter your email first.', 'error');
      return;
    }
    await sendPasswordReset(email);
  });
})();
