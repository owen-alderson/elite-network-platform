// admin.js — application + intro review queues for the sole admin.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) {
    console.error('admin.js: supabase.js must load first');
    return;
  }
  var supabase = window.aether.client;

  // ── State ───────────────────────────────────────────────────
  var currentAppFilter = 'pending';
  var currentIntroFilter = 'awaiting';
  var currentMemberFilter = 'active';
  var activeMembers = [];   // cached for the broker picker
  var editingEventId = null;  // null = creating, uuid = updating

  // ── DOM refs ────────────────────────────────────────────────
  var appListEl, appTabsEl, appStatEls;
  var introListEl, introTabsEl, introStatEls;
  var eventListEl, eventCreateBtn;
  var memberListEl, memberTabsEl, memberStatEls;

  // ── Boot ────────────────────────────────────────────────────
  (async function init() {
    var session = await window.aether.requireAdmin();
    if (!session) return;

    appListEl = document.getElementById('admin-list');
    appTabsEl = document.getElementById('admin-app-tabs');
    appStatEls = {
      pending: document.getElementById('stat-pending'),
      approved: document.getElementById('stat-approved'),
      rejected: document.getElementById('stat-rejected'),
      needs_more_info: document.getElementById('stat-needsinfo')
    };

    introListEl = document.getElementById('admin-intro-list');
    introTabsEl = document.getElementById('admin-intro-tabs');
    introStatEls = {
      pending: document.getElementById('intro-stat-pending'),
      assigned: document.getElementById('intro-stat-assigned'),
      forwarded: document.getElementById('intro-stat-forwarded'),
      declined: document.getElementById('intro-stat-declined')
    };

    eventListEl = document.getElementById('admin-event-list');
    eventCreateBtn = document.getElementById('evt-create-btn');

    memberListEl = document.getElementById('admin-member-list');
    memberTabsEl = document.getElementById('admin-member-tabs');
    memberStatEls = {
      active: document.getElementById('member-stat-active'),
      paused: document.getElementById('member-stat-paused'),
      removed: document.getElementById('member-stat-removed'),
      total: document.getElementById('member-stat-total')
    };

    bindViewSwitcher();
    bindAppTabs();
    bindIntroTabs();
    bindMemberTabs();
    if (eventCreateBtn) eventCreateBtn.addEventListener('click', saveEvent);

    await Promise.all([
      refreshApps(),
      loadActiveMembers().then(refreshIntros)
    ]);
  })();

  // ── View switcher ───────────────────────────────────────────
  function bindViewSwitcher() {
    var btns = document.querySelectorAll('.admin-view-btn');
    var sections = document.querySelectorAll('.admin-view-section');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.dataset.view;
        btns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        sections.forEach(function (s) { s.hidden = (s.dataset.view !== view); });
        if (view === 'intros') refreshIntros();
        if (view === 'applications') refreshApps();
        if (view === 'events') refreshEvents();
        if (view === 'members') refreshMembers();
      });
    });
  }

  function bindAppTabs() {
    appTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab');
      if (!btn) return;
      currentAppFilter = btn.dataset.status;
      appTabsEl.querySelectorAll('.admin-tab').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderApps();
    });
  }

  function bindIntroTabs() {
    introTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab');
      if (!btn) return;
      currentIntroFilter = btn.dataset.introFilter;
      introTabsEl.querySelectorAll('.admin-tab').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderIntros();
    });
  }

  function bindMemberTabs() {
    if (!memberTabsEl) return;
    memberTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab');
      if (!btn) return;
      currentMemberFilter = btn.dataset.memberFilter;
      memberTabsEl.querySelectorAll('.admin-tab').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderMembers();
    });
  }

  // ── Applications: load + render ─────────────────────────────
  async function refreshApps() {
    await Promise.all([loadAppStats(), renderApps()]);
  }

  async function loadAppStats() {
    var keys = Object.keys(appStatEls);
    await Promise.all(keys.map(async function (status) {
      var res = await supabase
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      var el = appStatEls[status];
      if (!el) return;
      el.textContent = res.error ? '?' : (res.count != null ? res.count : '0');
    }));
  }

  async function renderApps() {
    appListEl.innerHTML = '<p class="admin-loading">Loading…</p>';

    var query = supabase
      .from('applications')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (currentAppFilter !== 'all') query = query.eq('status', currentAppFilter);

    var res = await query;
    appListEl.innerHTML = '';

    if (res.error) {
      appListEl.appendChild(emptyMsg('Could not load applications: ' + res.error.message));
      return;
    }
    if (!res.data || !res.data.length) {
      appListEl.appendChild(emptyMsg('No applications in this view.'));
      return;
    }
    res.data.forEach(function (app) { appListEl.appendChild(buildAppCard(app)); });
  }

  function buildAppCard(app) {
    var article = el('article', 'app-card');
    article.dataset.id = app.id;
    article.appendChild(buildAppHead(app));
    article.appendChild(buildAppBody(app));
    article.appendChild(buildAppFoot(app));
    return article;
  }

  function buildAppHead(app) {
    var head = el('header', 'app-card-head');
    var left = el('div', 'app-card-head-left');
    left.appendChild(text('p', 'app-card-eyebrow',
      (app.submission_type === 'nominator' ? 'NOMINATION' : 'APPLICATION') +
      (app.applicant_pillar ? ' · ' + app.applicant_pillar.toUpperCase() : '')
    ));
    left.appendChild(text('h2', 'app-card-name', app.applicant_full_name || '—'));
    left.appendChild(text('p', 'app-card-email', app.applicant_email || ''));
    head.appendChild(left);

    var right = el('div', 'app-card-meta');
    right.appendChild(text('span', 'app-status app-status-' + app.status, prettyStatus(app.status)));
    right.appendChild(text('p', 'app-card-date', formatDate(app.submitted_at)));
    head.appendChild(right);
    return head;
  }

  function buildAppBody(app) {
    var body = el('div', 'app-card-body');
    addField(body, 'Headline', app.applicant_headline);
    addField(body, 'Credential', app.applicant_credential);
    addField(body, 'Current focus', app.applicant_current_work);
    addField(body, 'Location', app.applicant_location);

    if (app.applicant_linkedin_url) {
      body.appendChild(text('p', 'app-section-label', 'LinkedIn'));
      var link = document.createElement('a');
      link.href = app.applicant_linkedin_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'app-link';
      link.textContent = app.applicant_linkedin_url;
      body.appendChild(link);
    }

    if (Array.isArray(app.applicant_achievements) && app.applicant_achievements.length) {
      body.appendChild(text('p', 'app-section-label', 'Achievements'));
      var ul = el('ul', 'app-achievements');
      app.applicant_achievements.forEach(function (a) {
        var li = document.createElement('li');
        var year = a.year ? '(' + a.year + ') ' : '';
        var title = a.title || '';
        var details = a.details ? ' — ' + a.details : '';
        li.textContent = year + title + details;
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    if (app.submission_type === 'nominator') {
      body.appendChild(divider());
      body.appendChild(text('p', 'app-section-label app-section-label-strong', 'Nominator'));
      var who = [];
      if (app.nominator_full_name) who.push(app.nominator_full_name);
      if (app.nominator_email) who.push('<' + app.nominator_email + '>');
      body.appendChild(text('p', 'app-card-line', who.join(' ') || 'Not provided'));
      if (app.nominator_note) {
        body.appendChild(text('p', 'app-section-label', 'Endorsement'));
        body.appendChild(text('p', 'app-endorsement', app.nominator_note));
      }
    }
    return body;
  }

  function buildAppFoot(app) {
    if (app.status === 'pending' || app.status === 'needs_more_info') {
      return buildAppActionFoot(app);
    }
    var foot = el('footer', 'app-card-review-meta');
    var line = 'Reviewed ' + formatDate(app.reviewed_at);
    if (app.reviewer_notes) line += ' · ' + app.reviewer_notes;
    foot.textContent = line;
    return foot;
  }

  function buildAppActionFoot(app) {
    var foot = el('footer', 'app-card-actions');
    var notes = document.createElement('textarea');
    notes.className = 'app-notes';
    notes.placeholder = 'Reviewer notes (optional, visible only to admins)…';
    notes.value = app.reviewer_notes || '';
    foot.appendChild(notes);

    var btnRow = el('div', 'app-action-buttons');
    btnRow.appendChild(appActionBtn('Needs info', 'needs_more_info', 'btn-ghost btn-sm', app.id, notes));
    btnRow.appendChild(appActionBtn('Reject', 'rejected', 'btn-ghost btn-sm app-btn-reject', app.id, notes));
    btnRow.appendChild(appActionBtn('Approve', 'approved', 'btn-primary btn-sm', app.id, notes));
    foot.appendChild(btnRow);
    return foot;
  }

  function appActionBtn(label, status, classes, appId, notesEl) {
    var btn = document.createElement('button');
    btn.className = classes;
    btn.textContent = label;
    btn.addEventListener('click', async function () {
      if (status === 'rejected' && !confirm('Reject this application?')) return;
      if (status === 'approved' && !confirm('Approve this application? This sends an invite email and creates a member row.')) return;
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Saving…';
      var err = await reviewApplication(appId, status, notesEl.value.trim());
      if (err) {
        console.error('Review failed:', err);
        alert('Could not save review: ' + (err.message || 'unknown error'));
        btn.disabled = false;
        btn.textContent = original;
        return;
      }

      // For Approve: also kick off the invite + member-creation edge function.
      if (status === 'approved') {
        btn.textContent = 'Inviting…';
        var inviteErr = await inviteApplicant(appId);
        if (inviteErr) {
          console.error('Invite failed:', inviteErr);
          alert('Application approved, but invite failed: ' + (inviteErr.message || 'unknown error') +
                '\n\nYou can retry by approving again, or finish the invite manually in Supabase.');
          // Fall through to refresh; admin can see status moved but member missing.
        }
      }
      await refreshApps();
    });
    return btn;
  }

  async function reviewApplication(id, status, notes) {
    var session = await window.aether.getSession();
    if (!session) return { message: 'No session' };
    var res = await supabase.from('applications').update({
      status: status,
      reviewed_by: session.user.id,
      reviewed_at: new Date().toISOString(),
      reviewer_notes: notes || null
    }).eq('id', id);
    return res.error;
  }

  async function inviteApplicant(applicationId) {
    var res = await supabase.functions.invoke('invite-member', {
      body: { application_id: applicationId }
    });
    if (res.error) return res.error;
    if (res.data && res.data.error) return { message: res.data.error };
    return null;
  }

  // ── Intros: load + render ───────────────────────────────────
  async function loadActiveMembers() {
    var res = await supabase
      .from('members')
      .select('id, full_name, primary_pillar')
      .eq('status', 'active')
      .order('full_name');
    if (res.error) {
      console.error('loadActiveMembers error:', res.error);
      activeMembers = [];
      return;
    }
    activeMembers = res.data || [];
  }

  async function refreshIntros() {
    await Promise.all([loadIntroStats(), renderIntros()]);
  }

  // Stat queries map filter names → DB predicates.
  async function loadIntroStats() {
    var queries = {
      pending: function (q) { return q.eq('status', 'pending').is('broker_id', null); },
      assigned: function (q) { return q.eq('status', 'pending').not('broker_id', 'is', null); },
      forwarded: function (q) { return q.eq('status', 'forwarded'); },
      declined: function (q) { return q.in('status', ['declined', 'expired']); }
    };
    await Promise.all(Object.keys(queries).map(async function (key) {
      var q = supabase.from('intro_requests').select('id', { count: 'exact', head: true });
      q = queries[key](q);
      var res = await q;
      var elNode = introStatEls[key];
      if (!elNode) return;
      elNode.textContent = res.error ? '?' : (res.count != null ? res.count : '0');
    }));
  }

  async function renderIntros() {
    introListEl.innerHTML = '<p class="admin-loading">Loading…</p>';

    var q = supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, note, broker_id, forwarded_at, responded_at,' +
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city),' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city),' +
        'broker:members!broker_id(id,full_name)'
      )
      .order('created_at', { ascending: false });

    if (currentIntroFilter === 'awaiting') {
      q = q.eq('status', 'pending').is('broker_id', null);
    } else if (currentIntroFilter === 'assigned') {
      q = q.eq('status', 'pending').not('broker_id', 'is', null);
    } else if (currentIntroFilter === 'forwarded') {
      q = q.eq('status', 'forwarded');
    } else if (currentIntroFilter === 'declined') {
      q = q.in('status', ['declined', 'expired']);
    }

    var res = await q;
    introListEl.innerHTML = '';

    if (res.error) {
      introListEl.appendChild(emptyMsg('Could not load intros: ' + res.error.message));
      return;
    }
    if (!res.data || !res.data.length) {
      introListEl.appendChild(emptyMsg('No intros in this view.'));
      return;
    }
    res.data.forEach(function (intro) { introListEl.appendChild(buildIntroCard(intro)); });
  }

  function buildIntroCard(intro) {
    var article = el('article', 'app-card intro-card');
    article.dataset.id = intro.id;

    // Head
    var head = el('header', 'app-card-head');
    var left = el('div', 'app-card-head-left');
    left.appendChild(text('p', 'app-card-eyebrow', 'INTRO REQUEST'));
    var heading = el('h2', 'app-card-name');
    heading.textContent = (intro.requester && intro.requester.full_name ? intro.requester.full_name : '—') +
      ' → ' + (intro.target && intro.target.full_name ? intro.target.full_name : '—');
    left.appendChild(heading);

    var sub = [];
    if (intro.requester && intro.requester.headline) sub.push(intro.requester.headline);
    if (intro.target && intro.target.headline) sub.push('seeks ' + intro.target.headline);
    if (sub.length) left.appendChild(text('p', 'app-card-email', sub.join(' · ')));
    head.appendChild(left);

    var right = el('div', 'app-card-meta');
    right.appendChild(text('span', 'app-status intro-status-' + statusClassFor(intro), introStatusLabel(intro)));
    right.appendChild(text('p', 'app-card-date', formatDate(intro.created_at)));
    head.appendChild(right);

    article.appendChild(head);

    // Body — the note
    var body = el('div', 'app-card-body');
    body.appendChild(text('p', 'app-section-label', 'Requester’s note'));
    var noteEl = el('p', 'app-endorsement');
    noteEl.textContent = intro.note || '';
    body.appendChild(noteEl);

    if (intro.broker && intro.broker.full_name) {
      body.appendChild(text('p', 'app-section-label', 'Assigned broker'));
      body.appendChild(text('p', 'app-card-line', intro.broker.full_name));
    }
    if (intro.forwarded_at) {
      body.appendChild(text('p', 'app-section-label', 'Forwarded'));
      body.appendChild(text('p', 'app-card-line', formatDate(intro.forwarded_at)));
    }
    article.appendChild(body);

    // Foot — actions for actionable statuses
    if (intro.status === 'pending') {
      article.appendChild(buildIntroActionFoot(intro));
    } else {
      var foot = el('footer', 'app-card-review-meta');
      foot.textContent = 'Status: ' + introStatusLabel(intro) +
        (intro.responded_at ? ' · ' + formatDate(intro.responded_at) : '');
      article.appendChild(foot);
    }
    return article;
  }

  function buildIntroActionFoot(intro) {
    var foot = el('footer', 'app-card-actions');

    // Broker picker
    var pickerWrap = el('div', 'intro-picker-wrap');
    var label = text('label', 'app-section-label', intro.broker_id ? 'Reassign broker' : 'Assign broker');
    pickerWrap.appendChild(label);

    var select = document.createElement('select');
    select.className = 'app-notes intro-broker-select';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select a mutual member —';
    select.appendChild(blank);

    var requesterId = intro.requester ? intro.requester.id : null;
    var targetId = intro.target ? intro.target.id : null;
    activeMembers.forEach(function (m) {
      if (m.id === requesterId || m.id === targetId) return;
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.full_name + (m.primary_pillar ? ' · ' + m.primary_pillar.replace(/_/g, ' ') : '');
      if (intro.broker_id === m.id) opt.selected = true;
      select.appendChild(opt);
    });
    pickerWrap.appendChild(select);
    foot.appendChild(pickerWrap);

    var btnRow = el('div', 'app-action-buttons');
    btnRow.appendChild(introActionBtn('Decline', 'declined', 'btn-ghost btn-sm app-btn-reject', intro.id, select));
    btnRow.appendChild(introActionBtn(intro.broker_id ? 'Update broker' : 'Assign broker', 'assign', 'btn-primary btn-sm', intro.id, select));
    foot.appendChild(btnRow);
    return foot;
  }

  function introActionBtn(label, action, classes, introId, selectEl) {
    var btn = document.createElement('button');
    btn.className = classes;
    btn.textContent = label;
    btn.addEventListener('click', async function () {
      if (action === 'declined' && !confirm('Decline this intro request? The requester will see the status change.')) return;

      var brokerId = selectEl ? selectEl.value : '';
      if (action === 'assign' && !brokerId) {
        alert('Pick a broker from the dropdown first.');
        return;
      }
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Saving…';

      var err;
      if (action === 'assign') {
        err = await assignBroker(introId, brokerId);
      } else {
        err = await declineIntro(introId);
      }

      if (err) {
        console.error('Intro action failed:', err);
        alert('Could not save: ' + (err.message || 'unknown error'));
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      await refreshIntros();
    });
    return btn;
  }

  async function assignBroker(introId, brokerId) {
    var res = await supabase.from('intro_requests').update({
      broker_id: brokerId
    }).eq('id', introId);
    return res.error;
  }

  async function declineIntro(introId) {
    var res = await supabase.from('intro_requests').update({
      status: 'declined',
      responded_at: new Date().toISOString()
    }).eq('id', introId);
    return res.error;
  }

  function statusClassFor(intro) {
    if (intro.status === 'pending') return intro.broker_id ? 'assigned' : 'awaiting';
    return intro.status;
  }

  function introStatusLabel(intro) {
    if (intro.status === 'pending') return intro.broker_id ? 'WITH BROKER' : 'AWAITING BROKER';
    return intro.status.toUpperCase();
  }

  // ── Events: create + list + delete ──────────────────────────
  async function refreshEvents() {
    if (!eventListEl) return;
    eventListEl.innerHTML = '<p class="admin-loading">Loading…</p>';

    var res = await supabase
      .from('events')
      .select('id, title, description, starts_at, ends_at, location_text, capacity, status')
      .order('starts_at', { ascending: true });

    eventListEl.innerHTML = '';
    if (res.error) {
      eventListEl.appendChild(emptyMsg('Could not load events: ' + res.error.message));
      return;
    }
    if (!res.data || !res.data.length) {
      eventListEl.appendChild(emptyMsg('No events yet. Create one above.'));
      return;
    }
    res.data.forEach(function (ev) { eventListEl.appendChild(buildEventCard(ev)); });
  }

  function buildEventCard(ev) {
    var article = el('article', 'app-card');
    article.dataset.id = ev.id;

    var head = el('header', 'app-card-head');
    var left = el('div', 'app-card-head-left');
    left.appendChild(text('p', 'app-card-eyebrow', 'EVENT · ' + (ev.status || 'upcoming').toUpperCase()));
    left.appendChild(text('h2', 'app-card-name', ev.title || '—'));
    if (ev.location_text) left.appendChild(text('p', 'app-card-email', ev.location_text));
    head.appendChild(left);

    var right = el('div', 'app-card-meta');
    right.appendChild(text('p', 'app-card-date', formatDateTime(ev.starts_at)));
    if (ev.capacity) right.appendChild(text('p', 'app-card-date', 'Capacity ' + ev.capacity));
    head.appendChild(right);
    article.appendChild(head);

    if (ev.description) {
      var body = el('div', 'app-card-body');
      var p = el('p', 'app-card-line');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = ev.description;
      body.appendChild(p);
      article.appendChild(body);
    }

    var foot = el('footer', 'app-card-actions');
    var btnRow = el('div', 'app-action-buttons');

    var editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { editEvent(ev); });
    btnRow.appendChild(editBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-ghost btn-sm app-btn-reject';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async function () {
      if (!confirm('Delete this event? RSVPs are removed too.')) return;
      deleteBtn.disabled = true;
      var prev = deleteBtn.textContent;
      deleteBtn.textContent = 'Deleting…';
      var res = await supabase.from('events').delete().eq('id', ev.id);
      if (res.error) {
        alert('Could not delete: ' + (res.error.message || 'unknown error'));
        deleteBtn.disabled = false;
        deleteBtn.textContent = prev;
        return;
      }
      if (editingEventId === ev.id) cancelEventEdit();
      await refreshEvents();
    });
    btnRow.appendChild(deleteBtn);
    foot.appendChild(btnRow);
    article.appendChild(foot);

    return article;
  }

  function editEvent(ev) {
    editingEventId = ev.id;
    document.getElementById('evt-title').value = ev.title || '';
    document.getElementById('evt-starts').value = toDatetimeLocal(ev.starts_at);
    document.getElementById('evt-ends').value = ev.ends_at ? toDatetimeLocal(ev.ends_at) : '';
    document.getElementById('evt-location').value = ev.location_text || '';
    document.getElementById('evt-capacity').value = ev.capacity != null ? String(ev.capacity) : '';
    document.getElementById('evt-description').value = ev.description || '';

    if (eventCreateBtn) eventCreateBtn.textContent = 'Update event';
    var formHeading = document.querySelector('.admin-event-form .admin-form-heading');
    if (formHeading) formHeading.textContent = 'Edit event';
    ensureCancelEditBtn();

    var form = document.querySelector('.admin-event-form');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEventEdit() {
    editingEventId = null;
    ['evt-title', 'evt-starts', 'evt-ends', 'evt-location', 'evt-capacity', 'evt-description'].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.value = '';
    });
    if (eventCreateBtn) eventCreateBtn.textContent = 'Create event';
    var formHeading = document.querySelector('.admin-event-form .admin-form-heading');
    if (formHeading) formHeading.textContent = 'Create event';
    var cancelBtn = document.getElementById('evt-cancel-edit-btn');
    if (cancelBtn) cancelBtn.remove();
  }

  function ensureCancelEditBtn() {
    if (document.getElementById('evt-cancel-edit-btn')) return;
    var actions = document.querySelector('.admin-event-form .form-actions');
    if (!actions) return;
    var btn = document.createElement('button');
    btn.id = 'evt-cancel-edit-btn';
    btn.className = 'btn-ghost btn-sm';
    btn.textContent = 'Cancel edit';
    btn.addEventListener('click', cancelEventEdit);
    actions.insertBefore(btn, actions.firstChild);
  }

  function toDatetimeLocal(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  async function saveEvent() {
    var title = (document.getElementById('evt-title').value || '').trim();
    var startsLocal = (document.getElementById('evt-starts').value || '').trim();
    var endsLocal = (document.getElementById('evt-ends').value || '').trim();
    var location = (document.getElementById('evt-location').value || '').trim();
    var capacityRaw = (document.getElementById('evt-capacity').value || '').trim();
    var description = (document.getElementById('evt-description').value || '').trim();

    if (!title) { alert('Title is required.'); return; }
    if (!startsLocal) { alert('Start date/time is required.'); return; }

    var capacity = capacityRaw ? parseInt(capacityRaw, 10) : null;
    if (capacityRaw && (!Number.isFinite(capacity) || capacity <= 0)) {
      alert('Capacity must be a positive number.');
      return;
    }

    var session = await window.aether.getSession();
    if (!session) { alert('Session expired. Refresh the page.'); return; }

    var payload = {
      title: title,
      description: description || null,
      starts_at: new Date(startsLocal).toISOString(),
      ends_at: endsLocal ? new Date(endsLocal).toISOString() : null,
      location_text: location || null,
      capacity: capacity
    };

    eventCreateBtn.disabled = true;
    var prev = eventCreateBtn.textContent;
    eventCreateBtn.textContent = editingEventId ? 'Updating…' : 'Creating…';

    var res;
    if (editingEventId) {
      res = await supabase.from('events').update(payload).eq('id', editingEventId);
    } else {
      payload.created_by = session.user.id;
      res = await supabase.from('events').insert(payload);
    }

    eventCreateBtn.disabled = false;
    eventCreateBtn.textContent = prev;

    if (res.error) {
      console.error('Event save failed:', res.error);
      alert('Could not save event: ' + (res.error.message || 'unknown error'));
      return;
    }

    cancelEventEdit();
    await refreshEvents();
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  // ── Members admin ───────────────────────────────────────────
  async function refreshMembers() {
    await Promise.all([loadMemberStats(), renderMembers()]);
  }

  async function loadMemberStats() {
    var statuses = ['active', 'paused', 'removed'];
    await Promise.all(statuses.map(async function (s) {
      var res = await supabase
        .from('members')
        .select('id', { count: 'exact', head: true })
        .eq('status', s);
      var elNode = memberStatEls[s];
      if (elNode) elNode.textContent = res.error ? '?' : (res.count != null ? res.count : '0');
    }));
    var total = await supabase.from('members').select('id', { count: 'exact', head: true });
    if (memberStatEls.total) memberStatEls.total.textContent = total.error ? '?' : (total.count != null ? total.count : '0');
  }

  async function renderMembers() {
    if (!memberListEl) return;
    memberListEl.innerHTML = '<p class="admin-loading">Loading…</p>';

    var q = supabase
      .from('members')
      .select('id, full_name, email, headline, primary_pillar, location_city, location_country, status, joined_at, nominated_by')
      .order('joined_at', { ascending: false });
    if (currentMemberFilter !== 'all') q = q.eq('status', currentMemberFilter);

    var res = await q;
    memberListEl.innerHTML = '';

    if (res.error) {
      memberListEl.appendChild(emptyMsg('Could not load members: ' + res.error.message));
      return;
    }
    if (!res.data || !res.data.length) {
      memberListEl.appendChild(emptyMsg('No members in this view.'));
      return;
    }
    res.data.forEach(function (m) { memberListEl.appendChild(buildMemberCard(m)); });
  }

  function buildMemberCard(m) {
    var article = el('article', 'app-card');
    article.dataset.id = m.id;

    var head = el('header', 'app-card-head');
    var left = el('div', 'app-card-head-left');
    left.appendChild(text('p', 'app-card-eyebrow',
      'MEMBER' + (m.primary_pillar ? ' · ' + m.primary_pillar.toUpperCase().replace('_', ' ') : '')
    ));
    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(m.id);
    nameLink.style.color = 'inherit';
    nameLink.style.textDecoration = 'none';
    nameLink.textContent = m.full_name || '—';
    var nameWrap = el('h2', 'app-card-name');
    nameWrap.appendChild(nameLink);
    left.appendChild(nameWrap);
    if (m.email) left.appendChild(text('p', 'app-card-email', m.email));
    head.appendChild(left);

    var right = el('div', 'app-card-meta');
    right.appendChild(text('span', 'app-status member-status-' + m.status, (m.status || '').toUpperCase()));
    right.appendChild(text('p', 'app-card-date', m.joined_at ? 'Joined ' + new Date(m.joined_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ''));
    head.appendChild(right);
    article.appendChild(head);

    var body = el('div', 'app-card-body');
    if (m.headline) body.appendChild(text('p', 'app-card-line', m.headline));
    var loc = [m.location_city, m.location_country].filter(Boolean).join(', ');
    if (loc) {
      body.appendChild(text('p', 'app-section-label', 'Location'));
      body.appendChild(text('p', 'app-card-line', loc));
    }
    article.appendChild(body);

    var foot = el('footer', 'app-card-actions');
    var btnRow = el('div', 'app-action-buttons');

    if (m.status === 'active') {
      btnRow.appendChild(memberStatusBtn('Pause', 'paused', 'btn-ghost btn-sm', m.id));
      btnRow.appendChild(memberStatusBtn('Remove', 'removed', 'btn-ghost btn-sm app-btn-reject', m.id, 'Remove this member? They\'ll be hidden from the directory; their data stays in the DB.'));
    } else if (m.status === 'paused') {
      btnRow.appendChild(memberStatusBtn('Reactivate', 'active', 'btn-primary btn-sm', m.id));
      btnRow.appendChild(memberStatusBtn('Remove', 'removed', 'btn-ghost btn-sm app-btn-reject', m.id, 'Remove this member?'));
    } else if (m.status === 'removed') {
      btnRow.appendChild(memberStatusBtn('Reactivate', 'active', 'btn-primary btn-sm', m.id));
    }
    foot.appendChild(btnRow);
    article.appendChild(foot);

    return article;
  }

  function memberStatusBtn(label, newStatus, classes, memberId, confirmMsg) {
    var btn = document.createElement('button');
    btn.className = classes;
    btn.textContent = label;
    btn.addEventListener('click', async function () {
      if (confirmMsg && !confirm(confirmMsg)) return;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = 'Saving…';
      var res = await supabase.from('members').update({ status: newStatus }).eq('id', memberId);
      if (res.error) {
        alert('Could not update: ' + (res.error.message || 'unknown error'));
        btn.disabled = false;
        btn.textContent = prev;
        return;
      }
      await refreshMembers();
    });
    return btn;
  }

  // ── Tiny DOM helpers ────────────────────────────────────────
  function el(tag, className) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  }

  function text(tag, className, content) {
    var n = el(tag, className);
    n.textContent = content == null ? '' : String(content);
    return n;
  }

  function addField(container, label, value) {
    if (!value) return;
    container.appendChild(text('p', 'app-section-label', label));
    container.appendChild(text('p', 'app-card-line', value));
  }

  function divider() { return el('hr', 'app-divider'); }

  function emptyMsg(msg) {
    var p = el('p', 'admin-empty');
    p.textContent = msg;
    return p;
  }

  function prettyStatus(s) {
    if (!s) return '';
    return s.replace(/_/g, ' ');
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
})();
