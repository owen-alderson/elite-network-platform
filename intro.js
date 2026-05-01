// intro.js — warm-intro request modal.
// Used on any page that has the modal markup (dashboard.html, profile.html).
// Requires supabase.js to be loaded first.

(function () {
  if (!window.aether || !window.aether.client) {
    console.error('intro.js: supabase.js must load first');
    return;
  }
  var supabase = window.aether.client;

  function el(id) { return document.getElementById(id); }

  function setBodyLocked(locked) {
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  async function open(targetName, targetId) {
    var modal = el('intro-modal');
    var nameEl = el('modal-name');
    if (!modal || !nameEl) return;

    modal.dataset.targetId = targetId || '';
    nameEl.textContent = targetName || 'Member';

    var textarea = modal.querySelector('.intro-textarea');
    if (textarea) textarea.value = '';

    // Inject the routing hint so the requester knows whether their note
    // will reach a broker or go directly to the target.
    setRoutingHint(modal, null);
    modal.style.display = 'flex';
    setBodyLocked(true);

    if (targetId) {
      var session = await window.aether.getSession();
      if (!session) return;
      var rpc = await supabase.rpc('has_mutual_connection', { a: session.user.id, b: targetId });
      if (!rpc.error) {
        setRoutingHint(modal, rpc.data === true ? 'broker' : 'direct');
      }
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
      hint.textContent = 'No mutual connection on Aether yet. This request will go directly to the member; they\'ll see your note and decide whether to accept.';
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

    var session = await window.aether.getSession();
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

  // Also expose under the aether namespace for direct invocation
  // from generated JS (dashboard.js, profile.js).
  window.aetherIntro = {
    open: open,
    close: close,
    submit: submit
  };
})();
