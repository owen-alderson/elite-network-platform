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

  // iOS Safari ignores `overflow: hidden` on body — the page can still
  // scroll behind a fixed-positioned modal, which can move the modal's
  // backdrop with the page on touch. The position:fixed-with-saved-top
  // trick is the reliable cross-browser lock. We restore the original
  // scroll position on unlock so the page doesn't jump.
  var _savedScrollY = 0;
  function setBodyLocked(locked) {
    var body = document.body;
    if (locked) {
      _savedScrollY = window.scrollY || window.pageYOffset || 0;
      body.style.position = 'fixed';
      body.style.top = '-' + _savedScrollY + 'px';
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
      body.style.overflow = 'hidden';
    } else {
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      body.style.overflow = '';
      window.scrollTo(0, _savedScrollY);
    }
  }

  async function open(targetName, targetId) {
    var modal = el('intro-modal');
    var nameEl = el('modal-name');
    if (!modal || !nameEl) return;

    // Reset internal scroll on the inner panel each open — without
    // this the panel can stay scrolled from the previous open so the
    // title is below the visible area.
    var resetScroll = function () {
      var inner = modal.querySelector('.modal');
      if (inner) inner.scrollTop = 0;
      modal.scrollTop = 0;
    };

    // Profile-completeness gate: members with thin profiles shouldn't be
    // reaching out — there's nothing for the target to evaluate. Surface a
    // dedicated panel inside the same modal frame instead of opening the form.
    if (window.maia.canIntroNow) {
      var status = await window.maia.canIntroNow();
      if (!status.ready) {
        showCompletenessGate(modal, status);
        modal.style.display = 'flex';
        setBodyLocked(true);
        resetScroll();
        return;
      }
    }
    clearCompletenessGate(modal);

    modal.dataset.targetId = targetId || '';
    modal.dataset.targetName = targetName || 'Member';
    modal.dataset.selectedBrokerId = ''; // empty = direct
    nameEl.textContent = targetName || 'Member';

    var textarea = modal.querySelector('.intro-textarea');
    if (textarea) textarea.value = '';

    bindNoteCounter(modal);

    // Render the broker picker (or the direct-only fallback).
    renderBrokerPicker(modal, [], targetName, /* loading */ true);
    modal.style.display = 'flex';
    setBodyLocked(true);
    resetScroll();

    if (targetId) {
      var session = await window.maia.getSession();
      if (!session) return;
      // mutual_connections returns the set of member IDs connected to BOTH
      // me and the target — i.e. the valid brokers I could ask. Fetch
      // names/avatars for those IDs so the picker shows real people, not
      // UUIDs. If the call fails or returns empty, the picker falls back
      // to a "this will go directly to X" note with no radio choices.
      var mutualRpc = await supabase.rpc('mutual_connections', { a: session.user.id, b: targetId });
      var brokers = [];
      if (!mutualRpc.error && Array.isArray(mutualRpc.data) && mutualRpc.data.length > 0) {
        var ids = mutualRpc.data.map(function (row) {
          // RPC returns either an array of uuid strings or an array of {mutual_connections: uuid} rows
          if (typeof row === 'string') return row;
          if (row && row.mutual_connections) return row.mutual_connections;
          return null;
        }).filter(Boolean);
        if (ids.length) {
          var membersRes = await supabase
            .from('members')
            .select('id, full_name, avatar_url')
            .in('id', ids);
          if (!membersRes.error && Array.isArray(membersRes.data)) {
            brokers = membersRes.data;
          }
        }
      }
      renderBrokerPicker(modal, brokers, targetName, /* loading */ false);
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
      '<p class="modal-body">Members are more likely to accept an intro from someone they can evaluate. ' +
      'You\'ve filled <strong style="color:var(--gold);">' + status.score + ' of ' + status.total + '</strong> profile sections, <strong style="color:var(--gold);">any 2</strong> unlock intro requests. ' +
      'A photo and a line on what you\'re building is enough.</p>' +
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

  // Replace any prior routing hint / picker with a fresh one. When
  // `loading` is true, shows a skeleton line. With brokers, shows a
  // radio group: each mutual + a "send directly" option. With no
  // brokers, shows just the "this goes directly to X" hint and no
  // radios. Sets modal.dataset.selectedBrokerId on change ('' = direct).
  function renderBrokerPicker(modal, brokers, targetName, loading) {
    var body = modal.querySelector('.modal-body');
    if (!body) return;

    // Wipe the previous picker / hint if any.
    var prev = modal.querySelector('.intro-broker-picker');
    if (prev) prev.remove();
    var prevHint = modal.querySelector('.intro-routing-hint');
    if (prevHint) prevHint.remove();

    var wrap = document.createElement('div');
    wrap.className = 'intro-broker-picker';
    wrap.style.cssText = 'margin:0 0 14px;background:var(--surface);border:1px solid var(--border);padding:12px 14px;';

    if (loading) {
      wrap.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0;">Checking your mutual connections…</p>';
      body.parentNode.insertBefore(wrap, body.nextSibling);
      return;
    }

    if (!brokers || brokers.length === 0) {
      wrap.innerHTML =
        '<p style="font-size:11px;color:var(--muted);margin:0;line-height:1.5;">' +
        'You don\'t have a mutual connection with ' + escapeHtml(targetName || 'this member') + ' on Maia yet. ' +
        'This request will go directly to them; they\'ll see your note and decide whether to accept.' +
        '</p>';
      body.parentNode.insertBefore(wrap, body.nextSibling);
      modal.dataset.selectedBrokerId = '';
      return;
    }

    // Heading
    var heading = document.createElement('p');
    heading.style.cssText = 'font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--gold);margin:0 0 10px;';
    heading.textContent = 'Who should make the introduction?';
    wrap.appendChild(heading);

    var groupName = 'intro-broker-' + Math.random().toString(36).slice(2, 8);

    function makeRadio(value, labelHtml, checked) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4;color:var(--text);padding:6px 0;min-height:44px;cursor:pointer;';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = value;
      input.checked = !!checked;
      input.style.cssText = 'accent-color:var(--gold);margin:0;';
      input.addEventListener('change', function () {
        if (input.checked) modal.dataset.selectedBrokerId = value;
      });
      row.appendChild(input);
      var text = document.createElement('span');
      text.innerHTML = labelHtml;
      row.appendChild(text);
      return row;
    }

    // Default selection = direct. Owen wants "if they select no one then it
    // just goes to a direct connection" — preserve that by pre-checking direct.
    wrap.appendChild(makeRadio(
      '',
      'Send directly to <strong style="color:var(--white);">' + escapeHtml(targetName || 'this member') + '</strong>',
      true
    ));
    modal.dataset.selectedBrokerId = '';

    brokers.forEach(function (b) {
      var label = 'Ask <strong style="color:var(--white);">' + escapeHtml(b.full_name || 'a peer') + '</strong> to introduce us';
      wrap.appendChild(makeRadio(b.id, label, false));
    });

    body.parentNode.insertBefore(wrap, body.nextSibling);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      alert('Please write at least a couple of sentences, specific beats flattering.');
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

    // Empty string in dataset means "send directly" — translate to null
    // so the DB column stays clean (and the route trigger picks 'direct').
    var brokerId = modal.dataset.selectedBrokerId || null;

    var payload = {
      requester_id: session.user.id,
      target_id: targetId,
      note: note
    };
    if (brokerId) payload.broker_id = brokerId;

    var res = await supabase.from('intro_requests').insert(payload);

    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Request'; }

    if (res.error) {
      console.error('Intro request failed:', res.error);
      var msg = res.error.message || 'unknown error';
      if (res.error.code === '23505' || msg.indexOf('intro_requests_unique_pending_pair') !== -1) {
        alert('You already have a pending request to this member. Wait for a response or cancel the existing one from your dashboard.');
      } else if (msg.indexOf('5 pending direct') !== -1) {
        alert('You have 5 pending direct intro requests already. Wait for responses or cancel some from your dashboard.');
      } else if (msg.indexOf('not a mutual connection') !== -1) {
        alert('That introducer isn\'t a mutual connection any more, pick a different one or send directly.');
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
