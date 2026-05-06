// set-password.js — post-magic-link / post-recovery interstitial.
// Reached via two paths:
//   1. First-ever sign-in → user lands here from auth.js after magic-link
//      because user_metadata.has_password is undefined.
//   2. Recovery flow → resetPasswordForEmail's redirectTo points here, and
//      Supabase JS auto-establishes the recovery session via detectSessionInUrl.
//
// Both paths require an authenticated session — we gate via requireAuthOnly
// (a slimmer version of requireAuth that does NOT bounce to set-password.html
// even if has_password is unset; that would loop).
//
// Requires supabase.js + auth.js loaded first.

(function () {
  var form = document.getElementById('set-password-form');
  var newInput = document.getElementById('new-password');
  var confirmInput = document.getElementById('confirm-password');
  var submit = document.getElementById('set-password-submit');
  var status = document.getElementById('set-password-status');
  var title = document.getElementById('set-password-title');
  var subtitle = document.getElementById('set-password-subtitle');

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'login-status' + (kind ? ' is-' + kind : '');
  }

  // Gate: must be authenticated. Don't use requireAuth() — it would loop us
  // back here. We just need the session.
  (async function gate() {
    var session = await window.aether.getSession();
    if (!session) {
      // No session — the recovery / magic link probably expired or this page
      // was opened directly. Bounce to login.
      window.location.replace('login.html');
      return;
    }

    // If we got here from a recovery click, the URL hash will include
    // type=recovery. Adjust copy so the user knows this is a reset.
    if (window.location.hash && window.location.hash.indexOf('type=recovery') !== -1) {
      title.textContent = 'Set a new password';
      subtitle.textContent = "Pick something memorable. We'll sign you in with this from now on.";
    }
  })();

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    setStatus('');

    var pw = newInput.value;
    var confirm = confirmInput.value;

    if (!pw || pw.length < 8) {
      setStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    if (pw !== confirm) {
      setStatus("Passwords don't match.", 'error');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Saving...';

    var res = await window.aether.client.auth.updateUser({
      password: pw,
      data: { has_password: true }
    });

    if (res.error) {
      console.warn('updateUser error:', res.error.message);
      setStatus(res.error.message || "Couldn't set password — try again.", 'error');
      submit.disabled = false;
      submit.textContent = 'Set password & continue';
      return;
    }

    // Success — straight to dashboard. The has_password flag in user_metadata
    // means auth.js won't bounce them back here on next sign-in.
    setStatus('Password set. Welcome in.', 'success');
    setTimeout(function () {
      window.location.replace('dashboard.html');
    }, 600);
  });
})();
