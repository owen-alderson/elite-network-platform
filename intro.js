// intro.js — warm-intro request modal.
// Used on any page that has the modal markup (dashboard.html, profile.html).
// Requires supabase.js to be loaded first.

(function () {
  if (!window.maia || !window.maia.client) {
    console.error('intro.js: supabase.js must load first');
    return;
  }
  var supabase = window.maia.client;

  function el(id) { return document.getElementById(id); }

  function setBodyLocked(locked) {
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  async function open(targetName, targetId) {
    var modal = el('intro-modal');
    var nameEl = el('modal-name');
    if (!modal || !nameEl) return;

    // Profile-completeness gate: members with thin profiles shouldn't be
    // reaching out — there's nothing for the target to evaluate. Surface a
    // dedicated panel inside the same modal frame instead of opening the form.
    if (window.maia.canIntroNow) {
      var status = await window.maia.canIntroNow();
      if (!status.ready) {
        showCompletenessGate(modal, status);
        modal.style.display = 'flex';
        setBodyLocked(true);
        return;
      }
    }
    clearCompletenessGate(modal);

    modal.dataset.targetId = targetId || '';
    nameEl.textContent = targetName || 'Member';

    var textarea = modal.querySelector('.intro-textarea');
    if (textarea) textarea.value = '';

    bindNoteCounter(modal);

    // Inject the routing hint so the requester knows whether their note
    // will reach a broker or go directly to the target.
    setRoutingHint(modal, null);
    modal.style.display = 'flex';
    setBodyLocked(true);

    if (targetId) {
      var session = await window.maia.getSession();
      if (!session) return;
      var rpc = await supabase.rpc('has_mutual_connection', { a: session.user.id, b: targetId });
      if (!rpc.error) {
        setRoutingHint(modal, rpc.data === true ? 'broker' : 'direct');
      }
    }
  }

  function showCompletenessGate(modal, status) {
    clearCompletenessGate(modal);
    var inner = modal.querySelector('.modal');
    if (!inner) return;
    var gate = document.createElement('div');
    gate.className = 'intro-gate';
    gate.style.cssText = 'text-align:center;padding:8px 4px 4px;';
    gate.innerHTML =
      '<p class="flow-eyebrow" style="margin-bottom:12px;">Complete your profile</p>' +
      '<h3 class="modal-title">Add a few details first.</h3>' +
      '<p class="modal-body">Members are more likely to accept an intro from someone with a complete profile. ' +
      'You\'ve filled <strong style="color:var(--gold);">' + status.score + ' of ' + status.total + '</strong> sections — finish a couple more and intro requests will open up.</p>' +
      '<div class="modal-actions" style="justify-content:center;">' +
      '  <button type="button" class="btn-ghost btn-sm" data-gate-cancel>Not now</button>' +
      '  <a class="btn-primary btn-sm" href="profile.html">Go to profile</a>' +
      '</div>';
    // Hide the form siblings while the gate is active.
    Array.prototype.forEach.call(inner.children, function (c) {
      if (c.classList && (c.classList.contains('modal-close'))) return;
      c.style.display = 'none';
    });
    inner.appendChild(gate);
    var cancel = gate.querySelector('[data-gate-cancel]');
    if (cancel) cancel.addEventListener('click', close);
  }

  function clearCompletenessGate(modal) {
    var inner = modal.querySelector('.modal');
    if (!inner) return;
    var gate = inner.querySelector('.intro-gate');
    if (gate) gate.remove();
    Array.prototype.forEach.call(inner.children, function (c) {
      if (c.style) c.style.display = '';
    });
  }

  // Live counter beneath the textarea so the 20-char minimum (and 2000-char
  // ceiling) aren't surprises at submit time.
  var MIN_NOTE = 20;
  var MAX_NOTE = 2000;
  function bindNoteCounter(modal) {
    var textarea = modal.querySelector('.intro-textarea');
    if (!textarea || textarea.dataset.counterBound === '1') {
      if (textarea) updateCounter(modal, textarea.value.trim().length);
      return;
    }
    textarea.dataset.counterBound = '1';
    textarea.addEventListener('input', function () {
      updateCounter(modal, textarea.value.trim().length);
    });
    updateCounter(modal, 0);
  }
  function updateCounter(modal, n) {
    var counter = modal.querySelector('.intro-note-counter');
    if (!counter) {
      counter = document.createElement('p');
      counter.className = 'intro-note-counter';
      counter.style.cssText = 'font-size:11px;margin-top:6px;line-height:1.5;';
      var ta = modal.querySelector('.intro-textarea');
      if (ta && ta.parentNode) ta.parentNode.insertBefore(counter, ta.nextSibling);
      // Hide the static help line — counter replaces it.
      var help = ta && ta.parentNode ? ta.parentNode.querySelector('p[style*="font-size:11px"]:not(.intro-note-counter)') : null;
      if (help && help !== counter) help.style.display = 'none';
    }
    if (n === 0) {
      counter.textContent = '2–4 sentences. Specific beats flattering.';
      counter.style.color = '#444';
    } else if (n < MIN_NOTE) {
      counter.textContent = (MIN_NOTE - n) + ' more characters before you can send.';
      counter.style.color = 'var(--muted)';
    } else if (n > MAX_NOTE) {
      counter.textContent = (n - MAX_NOTE) + ' over the limit. Trim to send.';
      counter.style.color = '#b34c4c';
    } else {
      counter.textContent = 'Looks good. ' + n + ' characters.';
      counter.style.color = 'var(--gold)';
    }
  }

  function setRoutingHint(modal, route) {
    var hint = modal.querySelector('.intro-routing-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'intro-routing-hint';
      hint.style.cssText = 'font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--border);padding:8px 12px;margin:0 0 14px;line-height:1.5;';
      var body = modal.querySelector('.modal-body');
      if (body && body.parentNode) body.parentNode.insertBefore(hint, body.nextSibling);
    }
    if (route === 'broker') {
      hint.textContent = 'You share a mutual connection with this member. A peer will broker the introduction off-platform.';
      hint.style.display = '';
    } else if (route === 'direct') {
      hint.textContent = 'No mutual connection on Maia yet. This request will go directly to the member; they\'ll see your note and decide whether to accept.';
      hint.style.display = '';
    } else {
      hint.textContent = '';
      hint.style.display = 'none';
    }
  }

  function close() {
    var modal = el('intro-modal');
    if (!modal) return;
    modal.style.display = 'none';
    setBodyLocked(false);
  }

  function showConfirm() {
    var c = el('intro-confirm');
    if (c) c.style.display = 'flex';
  }

  function closeConfirm() {
    var c = el('intro-confirm');
    if (c) c.style.display = 'none';
    setBodyLocked(false);
  }

  async function submit() {
    var modal = el('intro-modal');
    if (!modal) return;
    var targetId = modal.dataset.targetId;
    var textarea = modal.querySelector('.intro-textarea');
    var note = textarea ? textarea.value.trim() : '';

    if (!targetId) { alert('No member selected.'); return; }
    if (!note || note.length < 20) {
      alert('Please write at least a couple of sentences — specific beats flattering.');
      return;
    }

    var session = await window.maia.getSession();
    if (!session) { alert('Your session has expired. Please sign in again.'); return; }

    if (session.user.id === targetId) {
      alert('You cannot request an intro to yourself.');
      return;
    }

    var sendBtn = modal.querySelector('.btn-primary');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

    var res = await supabase.from('intro_requests').insert({
      requester_id: session.user.id,
      target_id: targetId,
      note: note
    });

    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Request'; }

    if (res.error) {
      console.error('Intro request failed:', res.error);
      var msg = res.error.message || 'unknown error';
      if (res.error.code === '23505' || msg.indexOf('intro_requests_unique_pending_pair') !== -1) {
        alert('You already have a pending request to this member. Wait for a response or cancel the existing one from your dashboard.');
      } else if (msg.indexOf('5 pending direct') !== -1) {
        alert('You have 5 pending direct intro requests already. Wait for responses or cancel some from your dashboard.');
      } else {
        alert('Could not send the intro request: ' + msg);
      }
      return;
    }

    close();
    showConfirm();
  }

  // Override the inline placeholders on dashboard.html so the existing
  // onclick="submitIntro()" / closeModal() / closeConfirm() handlers
  // route to the wired versions.
  window.showIntroModal = open;
  window.submitIntro = submit;
  window.closeModal = close;
  window.closeConfirm = closeConfirm;

  // Also expose under the maia namespace for direct invocation
  // from generated JS (dashboard.js, profile.js).
  window.maiaIntro = {
    open: open,
    close: close,
    submit: submit
  };
})();
