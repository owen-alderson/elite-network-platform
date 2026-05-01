// dashboard.js — populate the logged-in home view with live member data
// and the intro-request feature surfaces.
// Requires supabase.js + auth.js + intro.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;
    setGreetingDate();

    // The since-banner needs last_seen_at BEFORE we stamp it. So fetch it
    // first, render the banner from the previous timestamp, then stamp.
    var lastSeenAt = await fetchLastSeenAt(session.user.id);

    await Promise.all([
      loadMyProfile(session.user.id, session.user.email),
      loadSuggestedConnections(session.user.id),
      loadReceivedRequests(session.user.id),
      loadBrokerQueue(session.user.id),
      loadMyRequests(session.user.id),
      loadConnections(session.user.id),
      loadUpcomingEvents(),
      loadInbox(session.user.id),
      loadSinceBanner(session.user.id, lastSeenAt),
      loadOnboardPrompt(session.user.id)
    ]);

    // Stamp last_seen_at to "now" so the next visit computes deltas
    // from this moment forward. Fire-and-forget; no need to block the UI.
    supabase.from('members')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', session.user.id)
      .then(function (res) {
        if (res.error) console.warn('last_seen_at stamp failed:', res.error);
      });

    // Refresh the inbox surface when a message or intro arrives in realtime.
    // auth.js subscribes and dispatches; we just react.
    var refreshTimer = null;
    window.addEventListener('aether:unread-changed', function () {
      if (refreshTimer) return; // Coalesce rapid bursts.
      refreshTimer = setTimeout(function () {
        refreshTimer = null;
        loadInbox(session.user.id);
      }, 400);
    });
  })();

  async function fetchLastSeenAt(userId) {
    var res = await supabase
      .from('members')
      .select('last_seen_at')
      .eq('id', userId)
      .maybeSingle();
    if (res.error || !res.data) return null;
    return res.data.last_seen_at;
  }

  // ── Profile + greeting ──────────────────────────────────────
  async function loadMyProfile(userId, fallbackEmail) {
    var res = await supabase
      .from('members')
      .select('full_name,headline,bio,primary_pillar,joined_at,avatar_url')
      .eq('id', userId)
      .maybeSingle();

    if (res.error) console.error('loadMyProfile error:', res.error);

    var member = res.data;
    var name = (member && member.full_name) || (fallbackEmail ? fallbackEmail.split('@')[0] : 'Member');
    var firstName = name.split(' ')[0];
    var headline = (member && member.headline) || '';
    var pillar = (member && member.primary_pillar) || '';

    setText('.nav-member-name', firstName + '.');
    var navAvatar = document.querySelector('.nav-avatar');
    if (navAvatar) window.aether.fillAvatar(navAvatar, member || { full_name: firstName });

    var dashAvatar = document.querySelector('.dash-avatar');
    if (dashAvatar) window.aether.fillAvatar(dashAvatar, member || { full_name: firstName });

    setText('.dash-profile-name', name);
    setHTML('.dash-profile-role', escapeText(headline) || '<span style="color:var(--muted);font-style:italic;">Headline not set</span>');
    var pillarTag = document.querySelector('.dash-pillar-tag');
    if (pillarTag) pillarTag.textContent = pillar ? '◈ ' + capitalize(pillar) : '◈ —';

    if (member && member.joined_at) {
      setText('#dash-member-since', String(new Date(member.joined_at).getFullYear()));
    }

    // First-time greeting: if a member has neither bio nor photo yet,
    // assume they just landed and nudge them toward profile completion.
    var profileSparse = !!member && !member.bio && !member.avatar_url;
    if (profileSparse) {
      setText('.dash-greeting-head', 'Welcome to Aether, ' + firstName + '.');
      setHTML(
        '.dash-greeting-sub',
        'Take two minutes to complete your profile so other members can find you. ' +
        '<a href="profile.html" style="color:var(--gold);border-bottom:1px solid var(--gold-dim);">Set it up →</a>'
      );
    } else {
      setText('.dash-greeting-head', greeting() + ', ' + firstName + '.');
      setText('.dash-greeting-sub', 'Welcome back. Browse the directory or explore what\'s on at Spring Place.');
    }
  }

  function setGreetingDate() {
    var d = new Date();
    setText('#dash-date-num', String(d.getDate()));
    setText('#dash-date-month', d.toLocaleString(undefined, { month: 'long' }));
  }

  // ── Suggested connections ───────────────────────────────────
  async function loadSuggestedConnections(currentUserId) {
    var listEl = document.querySelector('.suggestion-list');
    if (!listEl) return;

    // Pull every member we already have any intro_request with so the
    // suggestion list doesn't surface people we're already engaged with.
    var introRes = await supabase
      .from('intro_requests')
      .select('requester_id, target_id')
      .or('requester_id.eq.' + currentUserId + ',target_id.eq.' + currentUserId);
    var excludeIds = { };
    excludeIds[currentUserId] = true;
    (introRes.data || []).forEach(function (r) {
      excludeIds[r.requester_id] = true;
      excludeIds[r.target_id] = true;
    });

    var res = await supabase
      .from('members')
      .select('id,full_name,headline,primary_pillar,location_city,avatar_url')
      .eq('status', 'active')
      .order('joined_at', { ascending: false })
      .limit(20);

    listEl.innerHTML = '';
    if (res.error) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">Could not load suggestions.</p>';
      return;
    }
    var rows = (res.data || []).filter(function (m) { return !excludeIds[m.id]; }).slice(0, 4);
    if (!rows.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">No new members to suggest right now. Browse the directory directly.</p>';
      return;
    }
    var canIntro = await window.aether.canIntroNow();
    rows.forEach(function (m) { listEl.appendChild(buildSuggestionRow(m, canIntro.ready)); });
  }

  function buildSuggestionRow(m, canIntro) {
    var row = el('div', 'suggestion-row');
    var avatar = el('div', 'sug-avatar');
    window.aether.fillAvatar(avatar, m);
    row.appendChild(avatar);

    var info = el('div', 'sug-info');
    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(m.id);
    nameLink.style.color = 'inherit';
    nameLink.style.textDecoration = 'none';
    nameLink.textContent = m.full_name || '—';
    var nameWrap = el('p', 'sug-name');
    nameWrap.style.margin = '0';
    nameWrap.appendChild(nameLink);
    info.appendChild(nameWrap);

    info.appendChild(text('p', 'sug-role', m.headline || ''));

    var tagText = [];
    if (m.primary_pillar) tagText.push(capitalize(m.primary_pillar));
    if (m.location_city) tagText.push(m.location_city);
    info.appendChild(text('span', 'sug-tag', tagText.join(' · ')));
    row.appendChild(info);

    var btn;
    if (canIntro) {
      btn = document.createElement('button');
      btn.className = 'sug-intro-btn';
      btn.textContent = 'Request intro';
      btn.addEventListener('click', function () {
        window.aetherIntro.open(m.full_name || 'Member', m.id);
      });
    } else {
      btn = document.createElement('a');
      btn.className = 'sug-intro-btn sug-intro-locked';
      btn.href = 'profile.html?edit=1';
      btn.textContent = 'Finish profile';
      btn.title = 'Finish your profile to request intros';
    }
    row.appendChild(btn);

    return row;
  }

  // ── Finish your profile prompt ─────────────────────────────
  async function loadOnboardPrompt(userId) {
    var section = document.getElementById('onboard-section');
    if (!section) return;

    var res = await supabase.from('members')
      .select('avatar_url,bio,headline,location_city,location_country,current_work,linkedin_url,instagram_handle,website_url,achievements')
      .eq('id', userId)
      .maybeSingle();
    if (res.error || !res.data) { section.hidden = true; return; }

    var checks = window.aether.profileChecks(res.data);
    if (checks.score >= checks.total) { section.hidden = true; return; }

    var labelMap = {
      0: 'photo', 1: 'short bio', 2: 'headline', 3: 'location',
      4: 'what you\'re working on', 5: 'a link', 6: 'achievements'
    };
    var checksOrdered = [
      !!res.data.avatar_url,
      !!(res.data.bio && String(res.data.bio).trim()),
      !!(res.data.headline && String(res.data.headline).trim()),
      !!(res.data.location_city || res.data.location_country),
      !!(res.data.current_work && String(res.data.current_work).trim()),
      !!(res.data.linkedin_url || res.data.instagram_handle || res.data.website_url),
      Array.isArray(res.data.achievements) && res.data.achievements.length > 0
    ];
    var missing = [];
    checksOrdered.forEach(function (met, i) { if (!met) missing.push(labelMap[i]); });

    document.getElementById('onboard-score').textContent = checks.score + ' / ' + checks.total;
    var bodyEl = document.getElementById('onboard-missing');
    var ready = checks.ready;
    var lead = ready
      ? 'You can request intros now. A few more sections sharpen the picture.'
      : 'Add a few more sections so other members can find you — and so you can request intros.';
    bodyEl.textContent = lead + ' Missing: ' + missing.slice(0, 3).join(', ') +
      (missing.length > 3 ? ' and ' + (missing.length - 3) + ' more' : '') + '.';

    var fill = document.getElementById('onboard-fill');
    if (fill) fill.style.width = Math.round((checks.score / checks.total) * 100) + '%';

    section.hidden = false;
  }

  // ── Since you were last here ────────────────────────────────
  async function loadSinceBanner(userId, lastSeenAt) {
    var section = document.getElementById('since-section');
    var statsEl = document.getElementById('since-stats');
    if (!section || !statsEl) return;
    if (!lastSeenAt) { section.hidden = true; return; }

    // Fire all the count queries in parallel.
    var since = lastSeenAt;
    var counts = await Promise.all([
      // New unread messages received since last seen
      supabase.from('messages').select('id', { count: 'exact', head: true })
        .neq('sender_id', userId).is('read_at', null).gt('created_at', since),
      // New intro requests where I'm the broker (broker-route, status pending)
      supabase.from('intro_requests').select('id', { count: 'exact', head: true })
        .eq('broker_id', userId).eq('status', 'pending').gt('created_at', since),
      // New direct intro requests received
      supabase.from('intro_requests').select('id', { count: 'exact', head: true })
        .eq('target_id', userId).eq('route', 'direct').eq('status', 'pending').gt('created_at', since),
      // Intros I requested that just got forwarded
      supabase.from('intro_requests').select('id', { count: 'exact', head: true })
        .eq('requester_id', userId).eq('status', 'forwarded').gt('forwarded_at', since),
      // New connections — accepted intros where I'm a party, accepted since last seen
      supabase.from('intro_requests').select('id', { count: 'exact', head: true })
        .eq('status', 'accepted').gt('responded_at', since)
        .or('requester_id.eq.' + userId + ',target_id.eq.' + userId)
    ]);

    var items = [
      { label: 'new message',           plural: 'new messages',           count: counts[0].count || 0 },
      { label: 'broker request',        plural: 'broker requests',        count: counts[1].count || 0 },
      { label: 'intro request',         plural: 'intro requests',         count: counts[2].count || 0 },
      { label: 'forwarded intro',       plural: 'forwarded intros',       count: counts[3].count || 0 },
      { label: 'new connection',        plural: 'new connections',        count: counts[4].count || 0 }
    ].filter(function (it) { return it.count > 0; });

    if (!items.length) { section.hidden = true; return; }

    section.hidden = false;
    statsEl.innerHTML = '';
    items.forEach(function (it) {
      var pill = document.createElement('span');
      pill.className = 'dash-since-pill';
      pill.innerHTML =
        '<strong>' + it.count + '</strong> ' +
        (it.count === 1 ? it.label : it.plural);
      statsEl.appendChild(pill);
    });
  }

  // ── Received intro requests (direct route, I'm the target) ──
  async function loadReceivedRequests(userId) {
    var section = document.getElementById('received-section');
    var listEl = document.getElementById('received-list');
    var countEl = document.getElementById('received-count');
    if (!section || !listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, note, route,' +
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city,avatar_url)'
      )
      .eq('target_id', userId)
      .eq('route', 'direct')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (res.error) {
      console.error('loadReceivedRequests error:', res.error);
      section.hidden = true;
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (countEl) countEl.textContent = String(rows.length);
    listEl.innerHTML = '';
    rows.forEach(function (intro) { listEl.appendChild(buildReceivedCard(intro)); });
  }

  function buildReceivedCard(intro) {
    var card = el('article', 'intro-card-mini');
    var requester = intro.requester || {};

    var head = el('div', 'intro-mini-head');
    var people = el('div', 'intro-mini-people');
    people.appendChild(buildAvatar(requester));
    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(requester.id || '');
    nameLink.className = 'intro-mini-link intro-mini-link-strong';
    nameLink.textContent = requester.full_name || '—';
    people.appendChild(nameLink);
    head.appendChild(people);
    head.appendChild(text('span', 'intro-mini-date', relativeTime(intro.created_at)));
    card.appendChild(head);

    if (requester.headline) {
      card.appendChild(text('p', 'intro-mini-sub', requester.headline));
    }

    var note = el('blockquote', 'intro-mini-note');
    note.textContent = intro.note || '';
    card.appendChild(note);

    var actions = el('div', 'intro-mini-actions');
    actions.appendChild(introActionBtn('Decline', 'btn-ghost btn-sm app-btn-reject', function () {
      return updateIntro(intro.id, { status: 'declined', responded_at: new Date().toISOString() });
    }, 'Decline this introduction request? They\'ll see it as declined and won\'t be able to message you.'));
    actions.appendChild(introActionBtn('Accept', 'btn-primary btn-sm', function () {
      return updateIntro(intro.id, { status: 'accepted', responded_at: new Date().toISOString() });
    }));
    card.appendChild(actions);
    return card;
  }

  // ── Broker queue (intros assigned to me, still pending) ─────
  async function loadBrokerQueue(userId) {
    var section = document.getElementById('broker-section');
    var listEl = document.getElementById('broker-list');
    var countEl = document.getElementById('broker-count');
    if (!section || !listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, note,' +
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city,avatar_url),' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city,avatar_url)'
      )
      .eq('broker_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (res.error) {
      console.error('loadBrokerQueue error:', res.error);
      section.hidden = true;
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (countEl) countEl.textContent = String(rows.length);
    listEl.innerHTML = '';
    rows.forEach(function (intro) { listEl.appendChild(buildBrokerCard(intro, userId)); });
  }

  function buildBrokerCard(intro, currentUserId) {
    var card = el('article', 'intro-card-mini');

    var head = el('div', 'intro-mini-head');
    var requester = intro.requester || {};
    var target = intro.target || {};

    var leftHead = el('div', 'intro-mini-people');
    leftHead.appendChild(buildAvatar(requester));
    leftHead.appendChild(text('span', 'intro-arrow', '→'));
    leftHead.appendChild(buildAvatar(target));
    head.appendChild(leftHead);

    head.appendChild(text('span', 'intro-mini-date', relativeTime(intro.created_at)));
    card.appendChild(head);

    var line = el('p', 'intro-mini-line');
    var rname = document.createElement('strong');
    rname.textContent = requester.full_name || '—';
    var tname = document.createElement('a');
    tname.href = 'profile.html?id=' + encodeURIComponent(target.id || '');
    tname.className = 'intro-mini-link';
    tname.textContent = target.full_name || '—';
    line.appendChild(rname);
    line.appendChild(document.createTextNode(' would like an intro to '));
    line.appendChild(tname);
    line.appendChild(document.createTextNode('.'));
    card.appendChild(line);

    if (requester.headline || target.headline) {
      var sub = [];
      if (requester.headline) sub.push(requester.headline);
      if (target.headline) sub.push(target.headline);
      card.appendChild(text('p', 'intro-mini-sub', sub.join(' · ')));
    }

    var note = el('blockquote', 'intro-mini-note');
    note.textContent = intro.note || '';
    card.appendChild(note);

    var actions = el('div', 'intro-mini-actions');
    actions.appendChild(introActionBtn('Decline', 'btn-ghost btn-sm app-btn-reject', function () {
      return updateIntro(intro.id, { status: 'declined', responded_at: new Date().toISOString() });
    }, 'Decline this intro request?'));
    actions.appendChild(introActionBtn('Mark forwarded', 'btn-primary btn-sm', function () {
      return updateIntro(intro.id, { status: 'forwarded', forwarded_at: new Date().toISOString() });
    }));
    card.appendChild(actions);

    return card;
  }

  // ── My intro requests (everything I've sent) ────────────────
  async function loadMyRequests(userId) {
    var section = document.getElementById('my-requests-section');
    var listEl = document.getElementById('my-requests-list');
    if (!section || !listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, route, note, broker_id, forwarded_at, responded_at,' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city,avatar_url),' +
        'broker:members!broker_id(id,full_name,avatar_url)'
      )
      .eq('requester_id', userId)
      .order('created_at', { ascending: false });

    if (res.error) {
      console.error('loadMyRequests error:', res.error);
      section.hidden = true;
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    listEl.innerHTML = '';
    rows.forEach(function (intro) { listEl.appendChild(buildRequestCard(intro)); });
  }

  function buildRequestCard(intro) {
    var card = el('article', 'intro-card-mini');
    var target = intro.target || {};

    var head = el('div', 'intro-mini-head');
    var leftHead = el('div', 'intro-mini-people');
    leftHead.appendChild(buildAvatar(target));
    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(target.id || '');
    nameLink.className = 'intro-mini-link intro-mini-link-strong';
    nameLink.textContent = target.full_name || '—';
    leftHead.appendChild(nameLink);
    head.appendChild(leftHead);

    var statusKey;
    if (intro.status === 'pending') {
      if (intro.route === 'direct') statusKey = 'awaiting';
      else statusKey = intro.broker_id ? 'assigned' : 'awaiting';
    } else {
      statusKey = intro.status;
    }
    head.appendChild(text('span', 'app-status intro-status-' + statusKey, requestStatusLabel(intro)));
    card.appendChild(head);

    if (target.headline) {
      card.appendChild(text('p', 'intro-mini-sub', target.headline));
    }

    var note = el('blockquote', 'intro-mini-note');
    note.textContent = intro.note || '';
    card.appendChild(note);

    var meta = [];
    meta.push('Sent ' + relativeTime(intro.created_at));
    if (intro.broker && intro.broker.full_name) meta.push('Broker: ' + intro.broker.full_name);
    if (intro.status === 'forwarded' && intro.forwarded_at) meta.push('Forwarded ' + relativeTime(intro.forwarded_at));
    if (intro.responded_at && (intro.status === 'declined' || intro.status === 'accepted')) {
      meta.push(capitalize(intro.status) + ' ' + relativeTime(intro.responded_at));
    }
    card.appendChild(text('p', 'intro-mini-meta', meta.join(' · ')));

    // Requester actions: Cancel a pending request, or Mark accepted once
    // a forwarded intro has actually led somewhere.
    if (intro.status === 'pending' || intro.status === 'forwarded') {
      var actions = el('div', 'intro-mini-actions');
      if (intro.status === 'pending') {
        actions.appendChild(introActionBtn('Cancel request', 'btn-ghost btn-sm app-btn-reject', function () {
          return updateIntro(intro.id, { status: 'declined', responded_at: new Date().toISOString() });
        }, 'Cancel this intro request? It will move to declined.'));
      } else if (intro.status === 'forwarded') {
        actions.appendChild(introActionBtn('Mark accepted', 'btn-primary btn-sm', function () {
          return updateIntro(intro.id, { status: 'accepted', responded_at: new Date().toISOString() });
        }));
      }
      card.appendChild(actions);
    }

    return card;
  }

  function requestStatusLabel(intro) {
    if (intro.status === 'pending') {
      if (intro.route === 'direct') return 'AWAITING THEIR RESPONSE';
      return intro.broker_id ? 'WITH BROKER' : 'AWAITING BROKER';
    }
    return intro.status.toUpperCase();
  }

  // ── Connections (other party of each forwarded intro) ───────
  async function loadConnections(userId) {
    var section = document.getElementById('connections-section');
    var listEl = document.getElementById('connections-list');
    var countEl = document.getElementById('connections-count');
    if (!section || !listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, forwarded_at, responded_at, requester_id, target_id,' +
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city,avatar_url),' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city,avatar_url)'
      )
      .eq('status', 'accepted')
      .or('requester_id.eq.' + userId + ',target_id.eq.' + userId)
      .order('responded_at', { ascending: false });

    if (res.error) {
      console.error('loadConnections error:', res.error);
      section.hidden = true;
      return;
    }

    var seen = {};
    var connections = [];
    (res.data || []).forEach(function (intro) {
      var other = intro.requester_id === userId ? intro.target : intro.requester;
      if (!other || !other.id || seen[other.id]) return;
      seen[other.id] = true;
      connections.push({ member: other, forwarded_at: intro.responded_at || intro.forwarded_at });
    });

    if (!connections.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (countEl) countEl.textContent = String(connections.length);
    listEl.innerHTML = '';
    connections.forEach(function (c) { listEl.appendChild(buildConnectionCard(c)); });
  }

  function buildConnectionCard(c) {
    var m = c.member;
    var card = document.createElement('a');
    card.className = 'connection-card';
    card.href = 'profile.html?id=' + encodeURIComponent(m.id);

    var avatar = el('div', 'connection-avatar');
    window.aether.fillAvatar(avatar, m);
    card.appendChild(avatar);

    var info = el('div', 'connection-info');
    info.appendChild(text('p', 'connection-name', m.full_name || '—'));
    if (m.headline) info.appendChild(text('p', 'connection-headline', m.headline));

    var tags = [];
    if (m.primary_pillar) tags.push(capitalize(m.primary_pillar));
    if (m.location_city) tags.push(m.location_city);
    if (tags.length) info.appendChild(text('span', 'connection-tag', tags.join(' · ')));

    card.appendChild(info);

    if (c.forwarded_at) {
      card.appendChild(text('span', 'connection-when', 'Met ' + relativeTime(c.forwarded_at)));
    }
    return card;
  }

  // ── Upcoming events ─────────────────────────────────────────
  async function loadUpcomingEvents() {
    var section = document.getElementById('dash-events-section');
    var listEl = document.getElementById('dash-events-list');
    if (!section || !listEl) return;

    var nowIso = new Date().toISOString();
    var res = await supabase
      .from('events')
      .select('id, title, starts_at, location_text, capacity')
      .eq('status', 'upcoming')
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(3);

    if (res.error) {
      console.error('loadUpcomingEvents error:', res.error);
      section.hidden = true;
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    listEl.innerHTML = '';
    rows.forEach(function (ev) { listEl.appendChild(buildDashEventRow(ev)); });
  }

  function buildDashEventRow(ev) {
    var row = document.createElement('a');
    row.className = 'dash-event-row';
    row.href = 'event.html?id=' + encodeURIComponent(ev.id);
    var d = new Date(ev.starts_at);

    var date = el('div', 'dash-event-date');
    date.appendChild(text('span', 'dash-event-day', String(d.getDate())));
    date.appendChild(text('span', 'dash-event-month', d.toLocaleString(undefined, { month: 'short' })));
    row.appendChild(date);

    var info = el('div', 'dash-event-info');
    info.appendChild(text('p', 'dash-event-title', ev.title || '—'));
    var sub = [];
    sub.push(d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
    if (ev.location_text) sub.push(ev.location_text);
    info.appendChild(text('p', 'dash-event-sub', sub.join(' · ')));
    row.appendChild(info);

    var arrow = el('span', 'dash-event-arrow');
    arrow.textContent = '→';
    row.appendChild(arrow);
    return row;
  }

  // ── Inbox feed ──────────────────────────────────────────────
  async function loadInbox(userId) {
    var listEl = document.getElementById('inbox-list');
    var dot = document.getElementById('inbox-dot');
    if (!listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, route, broker_id, forwarded_at, responded_at, note, requester_id, target_id,' +
        'requester:members!requester_id(id,full_name,avatar_url),' +
        'target:members!target_id(id,full_name,avatar_url),' +
        'broker:members!broker_id(id,full_name,avatar_url)'
      )
      .or('requester_id.eq.' + userId + ',broker_id.eq.' + userId + ',and(target_id.eq.' + userId + ',route.eq.direct)')
      .order('created_at', { ascending: false })
      .limit(20);

    if (res.error) {
      console.error('loadInbox error:', res.error);
      listEl.innerHTML = '<p class="inbox-empty">Could not load notifications.</p>';
      return;
    }
    var rows = res.data || [];
    listEl.innerHTML = '';

    var actionableCount = 0;
    rows.forEach(function (intro) {
      var item = buildInboxItem(intro, userId);
      if (!item) return;
      if (item.dataset.unread === 'true') actionableCount++;
      listEl.appendChild(item);
    });

    // Unread messages — group by sender, prepend each as an inbox item.
    var msgItems = await buildUnreadMessageItems(userId);
    msgItems.forEach(function (item) {
      actionableCount++;
      listEl.insertBefore(item, listEl.firstChild);
    });

    if (!listEl.children.length) {
      listEl.innerHTML = '<p class="inbox-empty">Nothing new. Intros and updates will appear here.</p>';
    }

    if (dot) dot.style.display = actionableCount > 0 ? 'block' : 'none';
  }

  async function buildUnreadMessageItems(userId) {
    var res = await supabase
      .from('messages')
      .select('id, sender_id, body, created_at, sender:members!sender_id(id,full_name,avatar_url)')
      .neq('sender_id', userId)
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (res.error || !res.data || !res.data.length) return [];

    // Group by sender_id, keep newest message per sender.
    var bySender = {};
    res.data.forEach(function (m) {
      var s = bySender[m.sender_id];
      if (!s) {
        bySender[m.sender_id] = { sender: m.sender, latest: m, count: 1 };
      } else {
        s.count++;
        // res.data is already DESC by created_at, so first hit is newest.
      }
    });

    var items = [];
    Object.keys(bySender).forEach(function (sid) {
      var entry = bySender[sid];
      var item = el('a', 'inbox-item unread');
      item.href = 'messages.html?with=' + sid;
      item.dataset.unread = 'true';

      var avatar = el('div', 'inbox-avatar');
      window.aether.fillAvatar(avatar, entry.sender);
      item.appendChild(avatar);

      var content = el('div', 'inbox-content');
      var name = entry.sender ? entry.sender.full_name : 'A connection';
      var titleText = entry.count === 1
        ? name + ' sent you a message'
        : name + ' sent you ' + entry.count + ' messages';
      content.appendChild(text('p', 'inbox-title', titleText));
      if (entry.latest && entry.latest.body) {
        content.appendChild(text('p', 'inbox-body', entry.latest.body));
      }
      content.appendChild(text('p', 'inbox-time', relativeTime(entry.latest.created_at)));
      item.appendChild(content);

      items.push(item);
    });

    return items;
  }

  function buildInboxItem(intro, userId) {
    var iAmBroker = intro.broker_id === userId;
    var iAmRequester = intro.requester_id === userId;
    var iAmDirectTarget = (intro.route === 'direct' && intro.target_id === userId);
    if (!iAmBroker && !iAmRequester && !iAmDirectTarget) return null;

    var item = el('div', 'inbox-item');
    var unread = false;
    var title = '';
    var body = intro.note || '';
    var when = intro.created_at;
    var avatarMember;

    if (iAmDirectTarget) {
      avatarMember = intro.requester || null;
      if (intro.status === 'pending') {
        title = (intro.requester ? intro.requester.full_name : 'Someone') +
          ' would like to be introduced to you';
        unread = true;
      } else if (intro.status === 'accepted') {
        title = 'You met ' + (intro.requester ? intro.requester.full_name : '?') + ' through Aether';
        body = '';
        when = intro.responded_at || intro.created_at;
      } else if (intro.status === 'declined') {
        title = 'You declined ' + (intro.requester ? intro.requester.full_name : '?') + "'s request";
        body = '';
        when = intro.responded_at || intro.created_at;
      } else {
        return null;
      }
    } else if (iAmBroker) {
      avatarMember = intro.requester || null;
      if (intro.status === 'pending') {
        title = (intro.requester ? intro.requester.full_name : 'Someone') +
          ' asked you to introduce them to ' +
          (intro.target ? intro.target.full_name : 'a peer');
        unread = true;
      } else if (intro.status === 'forwarded') {
        title = 'You forwarded ' +
          (intro.requester ? intro.requester.full_name : '—') + ' → ' +
          (intro.target ? intro.target.full_name : '—');
        when = intro.forwarded_at || intro.created_at;
      } else if (intro.status === 'declined') {
        title = 'You declined ' +
          (intro.requester ? intro.requester.full_name : '—') + ' → ' +
          (intro.target ? intro.target.full_name : '—');
        when = intro.responded_at || intro.created_at;
      } else {
        return null;
      }
    } else {
      // I am the requester
      avatarMember = intro.target || null;
      if (intro.status === 'pending' && !intro.broker_id) {
        title = 'Your request to meet ' +
          (intro.target ? intro.target.full_name : '—') + ' is awaiting a broker';
      } else if (intro.status === 'pending' && intro.broker_id) {
        title = (intro.broker ? intro.broker.full_name : 'A broker') +
          ' will introduce you to ' +
          (intro.target ? intro.target.full_name : '—');
      } else if (intro.status === 'forwarded') {
        title = 'Your request to meet ' +
          (intro.target ? intro.target.full_name : '—') + ' was forwarded';
        body = (intro.broker ? intro.broker.full_name + ' has made the introduction.' : 'A broker has made the introduction.');
        when = intro.forwarded_at || intro.created_at;
        unread = true;
      } else if (intro.status === 'declined') {
        title = 'Your request to meet ' +
          (intro.target ? intro.target.full_name : '—') + ' was declined';
        body = '';
        when = intro.responded_at || intro.created_at;
      } else if (intro.status === 'accepted') {
        title = 'You met ' + (intro.target ? intro.target.full_name : '—') + ' through Aether';
        when = intro.responded_at || intro.created_at;
      } else {
        return null;
      }
    }

    if (unread) item.classList.add('unread');
    item.dataset.unread = unread ? 'true' : 'false';

    var avatar = el('div', 'inbox-avatar');
    window.aether.fillAvatar(avatar, avatarMember);
    item.appendChild(avatar);

    var content = el('div', 'inbox-content');
    content.appendChild(text('p', 'inbox-title', title));
    if (body) content.appendChild(text('p', 'inbox-body', body));
    content.appendChild(text('p', 'inbox-time', relativeTime(when)));
    item.appendChild(content);

    return item;
  }

  // ── Mutating actions ────────────────────────────────────────
  async function updateIntro(introId, patch) {
    var res = await supabase.from('intro_requests').update(patch).eq('id', introId);
    return res.error;
  }

  function introActionBtn(label, classes, doAction, confirmMsg) {
    var btn = document.createElement('button');
    btn.className = classes;
    btn.textContent = label;
    btn.addEventListener('click', async function () {
      if (confirmMsg && !confirm(confirmMsg)) return;
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Saving…';
      var err = await doAction();
      if (err) {
        console.error('Intro action failed:', err);
        alert('Could not save: ' + (err.message || 'unknown error'));
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      // Refresh the dashboard intro surfaces.
      var session = await window.aether.getSession();
      if (!session) { window.location.reload(); return; }
      await Promise.all([
        loadReceivedRequests(session.user.id),
        loadBrokerQueue(session.user.id),
        loadMyRequests(session.user.id),
        loadConnections(session.user.id),
        loadInbox(session.user.id)
      ]);
    });
    return btn;
  }

  // ── DOM helpers ─────────────────────────────────────────────
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
  function buildAvatar(memberOrName) {
    var a = el('div', 'intro-mini-avatar');
    if (memberOrName && typeof memberOrName === 'object') {
      window.aether.fillAvatar(a, memberOrName);
    } else {
      a.textContent = (memberOrName || '?').toString().charAt(0).toUpperCase();
    }
    return a;
  }
  function setText(selector, value) {
    var elNode = document.querySelector(selector);
    if (elNode) elNode.textContent = value;
  }
  function setHTML(selector, html) {
    var elNode = document.querySelector(selector);
    if (elNode) elNode.innerHTML = html;
  }
  function capitalize(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  function escapeText(s) {
    if (!s) return s;
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function relativeTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var diffMs = Date.now() - d.getTime();
    var minutes = Math.round(diffMs / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
})();
