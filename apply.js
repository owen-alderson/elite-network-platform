// apply.js — submit applicant + nomination forms to Supabase.
// Loaded after the inline script in apply.html, so we override
// window.submitApplication and window.submitNomination.
//
// Two flows live here:
//   1. APPLICANT FLOW (5-screen, rich)
//      Public path. Reached by anyone who lands on apply.html?code=XYZ&email=...
//      (sent by the nominee invite email) — pre-fills + locks email, persists
//      nomination_code on the row so admin can pair it with the nomination.
//   2. NOMINATOR FLOW (1-screen, minimal)
//      Members only. Auth-gated client-side (entry picker hides) AND server-
//      side (applications_validate_nominator trigger requires nominator_member_id
//      to match auth.uid()). Captures bare-minimum: nominee name, nominee email,
//      what they're doing now, why I value them. Generates an 8-char nomination
//      code which the nominee receives via email and uses to complete their
//      own applicant submission.
//
// Email plumbing: a postgres trigger (applications_send_confirmation) fires
// after every INSERT. The send-application-confirmation Edge Function sends
// one email for applicant rows and TWO emails for nominator rows (nominator
// confirmation + nominee invite with the code link).
//
// Requires supabase.js to be loaded first.

(function () {
  if (!window.maia || !window.maia.client) {
    console.error('apply.js: supabase.js must load first');
    return;
  }

  var supabase = window.maia.client;

  // Holds the nomination code/email pulled from URL params on load. When set,
  // submitApplication includes nomination_code in the payload so admin can
  // pair the applicant row with the parent nomination row.
  var nominationContext = null;

  document.addEventListener('DOMContentLoaded', function () {
    handleNominationCodeFromUrl();
    setupEntryGate();
  });

  // ── Nominee invite arrival: ?code=XYZ&email=foo@bar ─────────
  function handleNominationCodeFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');
    var email = params.get('email');
    if (!code || !email) return;

    nominationContext = { code: code, email: email.toLowerCase() };

    // Pre-fill + lock the email field so the applicant submission is
    // bound to the same email the nomination was issued for.
    var emailInput = document.getElementById('a-email');
    if (emailInput) {
      emailInput.value = email;
      emailInput.readOnly = true;
      emailInput.style.opacity = '0.7';
      emailInput.style.cursor = 'not-allowed';
    }

    // Skip the entry picker — go straight to applicant flow.
    if (typeof window.showScreen === 'function') {
      window.showScreen('a1');
    }
  }

  // ── Entry-card gate by auth state ───────────────────────────
  // Hides irrelevant card. If a logged-in member somehow lands with no code,
  // they only see "Nominate someone." If a logged-out visitor lands with no
  // code, they only see "I've been nominated."
  function setupEntryGate() {
    if (nominationContext) return; // already routed past entry picker

    window.maia.getSession().then(function (session) {
      var applyCard = document.querySelector('.entry-card[data-flow="apply"]');
      var nominateCard = document.querySelector('.entry-card[data-flow="nominate"]');
      var heading = document.getElementById('entry-heading');
      var sub = document.getElementById('entry-sub');

      if (session) {
        if (applyCard) applyCard.style.display = 'none';
        if (heading) heading.innerHTML = 'Nominate<br>a peer';
        if (sub) sub.textContent = 'Introduce someone exceptional. Maia grows through members vouching for the next cohort.';
      } else {
        if (nominateCard) nominateCard.style.display = 'none';
        if (heading) heading.innerHTML = 'Begin your<br>application';
        if (sub) sub.textContent = 'You should have received a nomination email with a unique link. If you haven\'t, you\'ll need a nomination from a current member before you can apply.';
      }
    });
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? (el.value || '').trim() : '';
  }

  function selectedPillarFrom(containerId) {
    var sel = document.querySelector('#' + containerId + ' .pillar-opt.selected');
    return sel ? sel.dataset.value : null;
  }

  function activeButton() {
    return document.querySelector('.flow-screen.active .btn-primary');
  }

  function setSubmitting(btn, label) {
    if (!btn) return;
    if (!btn.dataset.originalLabel) btn.dataset.originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || 'Submitting...';
  }

  function clearSubmitting(btn) {
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset.originalLabel) btn.textContent = btn.dataset.originalLabel;
  }

  function collectAchievements() {
    var entries = [];
    for (var i = 1; i <= 3; i++) {
      var entry = document.getElementById('ach-' + i);
      if (!entry) continue;
      var inputs = entry.querySelectorAll('input.form-input');
      var year = inputs[0] ? inputs[0].value.trim() : '';
      var title = inputs[1] ? inputs[1].value.trim() : '';
      var details = inputs[2] ? inputs[2].value.trim() : '';
      if (year || title || details) {
        entries.push({ year: year, title: title, details: details });
      }
    }
    return entries;
  }

  function go(screenId) {
    if (typeof window.showScreen === 'function') window.showScreen(screenId);
  }

  // 8-char alphanumeric, uppercase, no ambiguous characters (no 0/O/1/I).
  // Probability of collision with 32^8 ≈ 1.1 trillion possible codes is
  // negligible at pilot scale; the unique partial index on the column would
  // catch any collision on insert anyway.
  function generateNominationCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 8; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  // ── Applicant submit ────────────────────────────────────────
  window.submitApplication = async function () {
    var first = val('a-first');
    var last = val('a-last');
    var email = val('a-email').toLowerCase();
    var role = val('a-role');
    var city = val('a-city');
    var country = val('a-country');
    var credential = val('a-credential');
    var signature = val('a-signature');
    var current = val('a-current');
    var linkedin = val('a-linkedin');
    var pillar = selectedPillarFrom('pillar-select');
    var achievements = collectAchievements();

    if (!first || !last) { alert('Please enter your full name.'); return; }
    if (!email) { alert('Please enter your email address.'); return; }
    if (!pillar) { alert('Please select a pillar.'); return; }
    if (signature.length < 100) {
      alert('On step 4, the headlining accomplishment needs at least 100 characters. Be specific — names, numbers, dates.');
      return;
    }
    if (signature.length > 4000) {
      alert('Trim the headlining accomplishment to 4000 characters or fewer.');
      return;
    }
    var hasAch = achievements.some(function (a) { return a.title; });
    if (!hasAch) {
      alert('Add at least one supporting achievement on step 4 (year + title).');
      return;
    }

    // If the nominee arrived via ?code= and the email field was locked,
    // confirm the email still matches — defends against mid-flow tampering.
    if (nominationContext && email !== nominationContext.email) {
      alert('Email mismatch. Please use the link from your nomination email exactly.');
      return;
    }

    var location = [city, country].filter(Boolean).join(', ');

    var payload = {
      submission_type: 'applicant',
      applicant_full_name: first + ' ' + last,
      applicant_email: email,
      applicant_pillar: pillar,
      applicant_headline: role || null,
      applicant_credential: credential || null,
      applicant_signature_achievement: signature,
      applicant_achievements: achievements,
      applicant_linkedin_url: linkedin || null,
      applicant_location: location || null,
      applicant_current_work: current || null
    };

    // Pair with the parent nomination by code, when present. Admin queue can
    // group applicant + nominator rows that share a code.
    if (nominationContext) {
      payload.nomination_code = nominationContext.code;
    }

    var btn = activeButton();
    setSubmitting(btn);

    var res = await supabase.from('applications').insert(payload);
    if (res.error) {
      console.error('Application insert failed:', res.error);
      clearSubmitting(btn);
      if (isDuplicateError(res.error)) {
        alert('We already have an application from this email under review. You\'ll hear from us by email when there\'s an update.');
      } else {
        alert('Submission failed. Please try again — if it keeps happening, email hello@maiacircle.com.');
      }
      return;
    }

    // Confirmation email is dispatched server-side by a postgres trigger
    // that calls the send-application-confirmation edge function.
    go('a-confirm');
  };

  // ── Nomination submit (Option-A simplified — single screen) ─
  window.submitNomination = async function () {
    var nomFirst = val('n-nom-first');
    var nomLast = val('n-nom-last');
    var nomEmail = val('n-nom-email').toLowerCase();
    var nomCurrent = val('n-nom-current');
    var why = val('n-why');

    if (!nomFirst || !nomLast) { alert('Please enter your nominee\'s name.'); return; }
    if (!nomEmail) { alert('Please enter your nominee\'s email.'); return; }
    if (!nomCurrent) { alert('Please add a one-line description of what they\'re doing right now.'); return; }
    if (!why || why.length < 30) { alert('Your endorsement needs at least 30 characters — be specific about what makes them exceptional.'); return; }

    // Auth gate (client-side) — server-side trigger enforces this too, but
    // bouncing an unauthenticated visitor here gives a cleaner UX than a
    // 23xxx Postgres error.
    var session = await window.maia.getSession();
    if (!session) {
      alert('You need to be signed in as a member to nominate. Redirecting you to sign-in.');
      var loginUrl = new URL('login.html', window.location.href);
      loginUrl.searchParams.set('redirect', window.location.href);
      window.location.replace(loginUrl.toString());
      return;
    }

    // Pull nominator details from the session — no manual entry needed.
    var nominatorEmail = (session.user.email || '').toLowerCase();
    var nominatorName = '';
    try {
      var meRes = await supabase
        .from('members')
        .select('full_name')
        .eq('id', session.user.id)
        .maybeSingle();
      if (meRes && meRes.data && meRes.data.full_name) {
        nominatorName = meRes.data.full_name;
      }
    } catch (e) { /* fall through to email-derived name */ }
    if (!nominatorName) {
      nominatorName = nominatorEmail.split('@')[0].replace(/[.-]/g, ' ');
      // Title-case the fallback so admin queue isn't full of "owen alderson".
      nominatorName = nominatorName.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    // Build the nominator_note from the two free-text fields. Keeps both
    // signals in the same admin-readable string while preserving structure.
    var note = 'Doing now: ' + nomCurrent + '\n\nVouch: ' + why;

    var payload = {
      submission_type: 'nominator',
      applicant_full_name: nomFirst + ' ' + nomLast,
      applicant_email: nomEmail,
      applicant_current_work: nomCurrent,
      nominator_full_name: nominatorName,
      nominator_email: nominatorEmail,
      nominator_member_id: session.user.id,
      nominator_note: note,
      nomination_code: generateNominationCode()
    };

    var btn = activeButton();
    setSubmitting(btn);

    var res = await supabase.from('applications').insert(payload);
    if (res.error) {
      console.error('Nomination insert failed:', res.error);
      clearSubmitting(btn);
      if (isDuplicateError(res.error)) {
        alert('This person is already in our review queue (someone may have nominated them, or they may have applied directly). We\'ll handle it from here.');
      } else if (res.error.message && res.error.message.toLowerCase().indexOf('nominator') !== -1) {
        // applications_validate_nominator trigger fired — treat as auth issue
        alert('Your member session has expired. Please sign in again to nominate.');
      } else {
        alert('Submission failed. Please try again — if it keeps happening, email hello@maiacircle.com.');
      }
      return;
    }

    go('n-confirm');
  };

  // The DB has a partial unique index on (lower(applicant_email), submission_type)
  // where status in ('pending','needs_more_info'). Postgres returns SQLSTATE
  // 23505 (unique_violation); Supabase passes that through as code "23505".
  function isDuplicateError(err) {
    return err && (
      err.code === '23505'
      || (err.message && err.message.toLowerCase().indexOf('duplicate') !== -1)
      || (err.message && err.message.indexOf('applications_unique_open_email') !== -1)
    );
  }
})();
