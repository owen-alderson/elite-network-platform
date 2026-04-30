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

  function open(targetName, targetId) {
    var modal = el('intro-modal');
    var nameEl = el('modal-name');
    if (!modal || !nameEl) return;

    modal.dataset.targetId = targetId || '';
    nameEl.textContent = targetName || 'Member';

    var textarea = modal.querySelector('.intro-textarea');
    if (textarea) textarea.value = '';

    modal.style.display = 'flex';
    setBodyLocked(true);
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
      alert('Could not send the intro request: ' + (res.error.message || 'unknown error'));
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
