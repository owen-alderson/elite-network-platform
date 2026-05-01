// apply.js — submit applicant + nomination forms to Supabase.
// Loaded after the inline script in apply.html, so we override
// window.submitApplication and window.submitNomination.
//
// Requires supabase.js to be loaded first.

(function () {
  if (!window.aether || !window.aether.client) {
    console.error('apply.js: supabase.js must load first');
    return;
  }

  var supabase = window.aether.client;

  // Gate the entry-screen cards by session state. Visitors see only the
  // applicant flow; signed-in members see only the nominate flow.
  document.addEventListener('DOMContentLoaded', function () {
    window.aether.getSession().then(function (session) {
      var applyCard = document.querySelector('.entry-card[data-flow="apply"]');
      var nominateCard = document.querySelector('.entry-card[data-flow="nominate"]');
      var heading = document.getElementById('entry-heading');
      var sub = document.getElementById('entry-sub');

      if (session) {
        if (applyCard) applyCard.style.display = 'none';
        if (heading) heading.innerHTML = 'Nominate<br>a peer';
        if (sub) sub.textContent = 'Introduce someone exceptional. Aether grows through members vouching for the next cohort.';
      } else {
        if (nominateCard) nominateCard.style.display = 'none';
        if (heading) heading.innerHTML = 'Begin your<br>application';
        if (sub) sub.textContent = 'You should have received a nomination from an existing Aether member. If you haven\'t, you\'ll need one before you can apply.';
      }
    });
  });

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

    var btn = activeButton();
    setSubmitting(btn);

    var res = await supabase.from('applications').insert(payload);
    if (res.error) {
      console.error('Application insert failed:', res.error);
      clearSubmitting(btn);
      if (isDuplicateError(res.error)) {
        alert('We already have an application from this email under review. You\'ll hear from us by email when there\'s an update.');
      } else {
        alert('Submission failed. Please try again — if it keeps happening, email hello@aether.network.');
      }
      return;
    }

    // Confirmation email is dispatched server-side by a postgres trigger
    // that calls the send-application-confirmation edge function. apply.js
    // doesn't need to do anything else.
    go('a-confirm');
  };

  // ── Nomination submit ───────────────────────────────────────
  window.submitNomination = async function () {
    var nomFirst = val('n-nom-first');
    var nomLast = val('n-nom-last');
    var nomEmail = val('n-nom-email').toLowerCase();
    var nomLinkedin = val('n-nom-linkedin');
    var nominatorName = val('n-name');
    var nominatorEmail = val('n-email').toLowerCase();
    var why = val('n-why');
    var relationship = val('n-relationship');
    var pillar = selectedPillarFrom('pillar-select-n');

    if (!nomFirst || !nomLast) { alert('Please enter your nominee’s full name.'); return; }
    if (!nomEmail) { alert('Please enter your nominee’s email.'); return; }
    if (!nominatorName) { alert('Please enter your name.'); return; }
    if (!nominatorEmail) { alert('Please enter your member email.'); return; }
    if (!pillar) { alert('Please select a pillar for your nominee.'); return; }
    if (!why || why.length < 50) { alert('Endorsement must be at least 50 characters — be specific.'); return; }

    var note = why;
    if (relationship) note += '\n\nHow they know them: ' + relationship;

    // If a logged-in member is submitting the nomination, link the
    // application to their member id so invite-member can stamp the new
    // member's nominated_by field correctly.
    var session = await window.aether.getSession();
    var nominatorMemberId = session ? session.user.id : null;

    var payload = {
      submission_type: 'nominator',
      applicant_full_name: nomFirst + ' ' + nomLast,
      applicant_email: nomEmail,
      applicant_pillar: pillar,
      applicant_linkedin_url: nomLinkedin || null,
      nominator_full_name: nominatorName,
      nominator_email: nominatorEmail,
      nominator_member_id: nominatorMemberId,
      nominator_note: note
    };

    var btn = activeButton();
    setSubmitting(btn);

    var res = await supabase.from('applications').insert(payload);
    if (res.error) {
      console.error('Nomination insert failed:', res.error);
      clearSubmitting(btn);
      if (isDuplicateError(res.error)) {
        alert('This person is already in our review queue (someone may have nominated them, or they may have applied directly). We\'ll handle it from here.');
      } else {
        alert('Submission failed. Please try again — if it keeps happening, email hello@aether.network.');
      }
      return;
    }

    go('n-confirm');
  };

  // The DB has a partial unique index on (lower(applicant_email))
  // where status in ('pending','needs_more_info'). Postgres returns
  // SQLSTATE 23505 (unique_violation); Supabase passes that through
  // as code "23505".
  function isDuplicateError(err) {
    return err && (
      err.code === '23505'
      || (err.message && err.message.toLowerCase().indexOf('duplicate') !== -1)
      || (err.message && err.message.indexOf('applications_unique_open_email') !== -1)
    );
  }
})();
