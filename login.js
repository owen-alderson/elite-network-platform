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
// Auth emails (paths 2 + 3) go out via custom SMTP → Resend (wired 6/18;
// the old built-in 2/hour cap no longer applies). Password sign-in (path 1)
// is the steady-state flow and uses zero email. The configured Auth email
// rate limit can still 429 a burst — surfaced honestly below.
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

  // If the user just arrived from a dead magic link (supabase.js stashes the
  // error_code it finds in the URL fragment), say so plainly instead of
  // presenting a blank sign-in form — otherwise expired links read as an
  // unexplained loop back to this page.
  (function surfaceAuthError() {
    var code = null;
    try {
      code = sessionStorage.getItem('maia_auth_error');
      sessionStorage.removeItem('maia_auth_error');
    } catch (e) { /* private mode */ }
    if (!code) return;
    if (code === 'otp_expired') {
      setStatus('That sign-in link has expired or was already used. Enter your email below and we’ll send you a fresh one — the new email also contains a 6-digit code you can type in directly.', 'error');
    } else {
      setStatus('That sign-in link didn’t work. Enter your email below and we’ll send you a fresh one.', 'error');
    }
    emailInput.focus();
  })();

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
      // Rate limits must be surfaced honestly. Before this, a rate-limited
      // request still showed "a link is on its way" — the member waited for
      // an email that was never sent, re-clicked their old expired link, and
      // looped. Saying "wait a few minutes" leaks nothing about whether the
      // account exists (the limit applies either way).
      var msg = res.error.message || '';
      if (res.error.status === 429 || /rate ?limit|too many/i.test(msg)) {
        setStatus('We’ve sent you several emails recently, so this one was held back. Wait a couple of minutes and try again — or use the 6-digit code from the last email we sent you.', 'error');
        showCodeEntry(email);
        submit.disabled = false;
        submit.textContent = 'Sign in';
        return;
      }
    }

    // Always show the same generic message — anti-enumeration.
    setStatus('If you are a member, a sign-in link is on its way to your inbox. You can click the link — or type the 6-digit code from the email below.', 'success');
    submit.textContent = 'Sent';
    showCodeEntry(email);
    // Leave submit disabled.
  }

  // ── Path 2b: 6-digit code entry ─────────────────────────────
  // The magic-link email carries a one-time code alongside the link. Typing
  // the code sidesteps everything that breaks link-clicking on mobile:
  // in-app email browsers, cross-device sign-in, and corporate link scanners
  // that consume the link before the member ever taps it.
  var codeBlock = document.getElementById('login-code-block');
  var codeInput = document.getElementById('login-code');
  var codeSubmit = document.getElementById('login-code-submit');
  var codeEmail = null;

  function showCodeEntry(email) {
    codeEmail = email;
    if (!codeBlock) return;
    codeBlock.hidden = false;
  }

  async function verifyCode() {
    var token = (codeInput.value || '').replace(/\D/g, '');
    if (token.length !== 6) {
      setStatus('The code is the 6 digits from the sign-in email.', 'error');
      return;
    }
    var email = codeEmail || getEmail();
    if (!email) {
      setStatus('Enter your email first.', 'error');
      return;
    }
    codeSubmit.disabled = true;
    codeSubmit.textContent = 'Verifying...';

    // Magic-link codes verify as type "email"; codes from admin-generated
    // invite links verify as type "magiclink". Try both so one input works
    // for every email we send.
    var res = await window.maia.client.auth.verifyOtp({ email: email, token: token, type: 'email' });
    if (res.error) {
      res = await window.maia.client.auth.verifyOtp({ email: email, token: token, type: 'magiclink' });
    }

    if (res.error) {
      console.warn('Code verification error:', res.error.message);
      setStatus('That code didn’t work — it may have expired. Request a fresh sign-in email and use the new code.', 'error');
      codeSubmit.disabled = false;
      codeSubmit.textContent = 'Verify code';
      return;
    }

    window.location.replace(redirectTo);
  }

  if (codeSubmit) {
    codeSubmit.addEventListener('click', function (event) {
      event.preventDefault();
      verifyCode();
    });
  }
  if (codeInput) {
    codeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        verifyCode();
      }
    });
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
