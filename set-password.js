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
  // Capture the URL hash NOW, synchronously at module load — BEFORE supabase.js's
  // async token bootstrap strips it via history.replaceState. A recovery link
  // arrives as #access_token=...&type=recovery; by the time gate() awaits
  // getSession() the fragment is already gone, so the later re-read always
  // missed 'type=recovery' (the guard was dead code). This preserves it.
  var arrivedViaRecovery = (window.location.hash || '').indexOf('type=recovery') !== -1;

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
    // Keyboard-open on a phone pushes this status line below the submit button
    // and behind the keyboard; scroll validation errors into view so a too-short
    // or mismatched password isn't a silent no-op.
    if (kind === 'error' && text) {
      try { status.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (e) { status.scrollIntoView(); }
    }
  }

  // Gate: must be authenticated. Don't use requireAuth() — it would loop us
  // back here. We just need the session.
  (async function gate() {
    var session = await window.maia.getSession();
    if (!session) {
      // No session — the recovery / magic link probably expired or this page
      // was opened directly. Bounce to login.
      window.location.replace('login.html');
      return;
    }

    // If we got here from a recovery click, the URL hash will include
    // type=recovery. Adjust copy so the user knows this is a reset, and hide
    // "Skip for now" — a recovery visit must end in a new password.
    if (arrivedViaRecovery) {
      title.textContent = 'Set a new password';
      subtitle.textContent = "Pick something memorable. We'll sign you in with this from now on.";
      var skipWrap = document.getElementById('set-password-skip-wrap');
      if (skipWrap) skipWrap.style.display = 'none';
    }
  })();

  // "Skip for now" — member opts out of setting a password. We record the
  // choice in user_metadata.password_setup_skipped so auth.js stops routing
  // them here; they keep signing in with email sign-in links. This is the
  // escape hatch that makes the first-sign-in gate impossible to get stuck in.
  var skip = document.getElementById('set-password-skip');
  if (skip) {
    skip.addEventListener('click', async function (event) {
      event.preventDefault();
      skip.textContent = 'One moment…';
      var res = await window.maia.client.auth.updateUser({
        data: { password_setup_skipped: true }
      });
      if (res.error) {
        console.warn('skip updateUser error:', res.error.message);
        setStatus("Couldn't skip, try again, or set a password above.", 'error');
        skip.textContent = "Skip for now, I'll use a sign-in link";
        return;
      }
      window.location.replace('dashboard.html');
    });
  }

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

    var res = await window.maia.client.auth.updateUser({
      password: pw,
      data: { has_password: true }
    });

    if (res.error) {
      console.warn('updateUser error:', res.error.message);
      setStatus(res.error.message || "Couldn't set password, try again.", 'error');
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
