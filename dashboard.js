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
    await Promise.all([
      loadMyProfile(session.user.id, session.user.email),
      loadSuggestedConnections(session.user.id),
      loadBrokerQueue(session.user.id),
      loadMyRequests(session.user.id),
      loadConnections(session.user.id),
      loadInbox(session.user.id)
    ]);
  })();

  // ── Profile + greeting ──────────────────────────────────────
  async function loadMyProfile(userId, fallbackEmail) {
    var res = await supabase
      .from('members')
      .select('full_name,headline,primary_pillar')
      .eq('id', userId)
      .maybeSingle();

    if (res.error) console.error('loadMyProfile error:', res.error);

    var member = res.data;
    var name = (member && member.full_name) || (fallbackEmail ? fallbackEmail.split('@')[0] : 'Member');
    var firstName = name.split(' ')[0];
    var initial = firstName.charAt(0).toUpperCase();
    var headline = (member && member.headline) || '';
    var pillar = (member && member.primary_pillar) || '';

    setText('.nav-member-name', firstName + '.');
    setText('.nav-avatar', initial);

    setText('.dash-avatar', initial);
    setText('.dash-profile-name', name);
    setHTML('.dash-profile-role', escapeText(headline) || '<span style="color:var(--muted);font-style:italic;">Headline not set</span>');
    var pillarTag = document.querySelector('.dash-pillar-tag');
    if (pillarTag) pillarTag.textContent = pillar ? '◈ ' + capitalize(pillar) : '◈ —';

    setText('.dash-greeting-head', greeting() + ', ' + firstName + '.');
    setText('.dash-greeting-sub', 'Welcome back. Browse the directory or explore what\'s on at Spring Place.');
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

    var res = await supabase
      .from('members')
      .select('id,full_name,headline,primary_pillar,location_city')
      .eq('status', 'active')
      .neq('id', currentUserId)
      .order('joined_at', { ascending: false })
      .limit(4);

    listEl.innerHTML = '';
    if (res.error) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">Could not load suggestions.</p>';
      return;
    }
    if (!res.data || !res.data.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">No other members yet — once your cohort joins, they\'ll appear here.</p>';
      return;
    }
    res.data.forEach(function (m) { listEl.appendChild(buildSuggestionRow(m)); });
  }

  function buildSuggestionRow(m) {
    var row = el('div', 'suggestion-row');
    var avatar = el('div', 'sug-avatar');
    avatar.textContent = (m.full_name || '?').charAt(0).toUpperCase();
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

    var btn = document.createElement('button');
    btn.className = 'sug-intro-btn';
    btn.textContent = 'Request intro';
    btn.addEventListener('click', function () {
      window.aetherIntro.open(m.full_name || 'Member', m.id);
    });
    row.appendChild(btn);

    return row;
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
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city),' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city)'
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
    leftHead.appendChild(buildAvatar(requester.full_name));
    leftHead.appendChild(text('span', 'intro-arrow', '→'));
    leftHead.appendChild(buildAvatar(target.full_name));
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
        'id, created_at, status, note, broker_id, forwarded_at, responded_at,' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city),' +
        'broker:members!broker_id(id,full_name)'
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
    leftHead.appendChild(buildAvatar(target.full_name));
    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(target.id || '');
    nameLink.className = 'intro-mini-link intro-mini-link-strong';
    nameLink.textContent = target.full_name || '—';
    leftHead.appendChild(nameLink);
    head.appendChild(leftHead);

    var statusKey = intro.status === 'pending'
      ? (intro.broker_id ? 'assigned' : 'awaiting')
      : intro.status;
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

    return card;
  }

  function requestStatusLabel(intro) {
    if (intro.status === 'pending') return intro.broker_id ? 'WITH BROKER' : 'AWAITING BROKER';
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
        'id, forwarded_at, requester_id, target_id,' +
        'requester:members!requester_id(id,full_name,headline,primary_pillar,location_city),' +
        'target:members!target_id(id,full_name,headline,primary_pillar,location_city)'
      )
      .eq('status', 'forwarded')
      .or('requester_id.eq.' + userId + ',target_id.eq.' + userId)
      .order('forwarded_at', { ascending: false });

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
      connections.push({ member: other, forwarded_at: intro.forwarded_at });
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
    avatar.textContent = (m.full_name || '?').charAt(0).toUpperCase();
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

  // ── Inbox feed ──────────────────────────────────────────────
  async function loadInbox(userId) {
    var listEl = document.getElementById('inbox-list');
    var dot = document.getElementById('inbox-dot');
    if (!listEl) return;

    var res = await supabase
      .from('intro_requests')
      .select(
        'id, created_at, status, broker_id, forwarded_at, responded_at, note, requester_id, target_id,' +
        'requester:members!requester_id(id,full_name),' +
        'target:members!target_id(id,full_name),' +
        'broker:members!broker_id(id,full_name)'
      )
      .or('requester_id.eq.' + userId + ',broker_id.eq.' + userId)
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

    if (!listEl.children.length) {
      listEl.innerHTML = '<p class="inbox-empty">Nothing new. Intros and updates will appear here.</p>';
    }

    if (dot) dot.style.display = actionableCount > 0 ? 'block' : 'none';
  }

  function buildInboxItem(intro, userId) {
    var iAmBroker = intro.broker_id === userId;
    var iAmRequester = intro.requester_id === userId;
    if (!iAmBroker && !iAmRequester) return null;

    var item = el('div', 'inbox-item');
    var unread = false;
    var title = '';
    var body = intro.note || '';
    var when = intro.created_at;
    var avatarSeed;

    if (iAmBroker) {
      avatarSeed = intro.requester ? intro.requester.full_name : '?';
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
      avatarSeed = intro.target ? intro.target.full_name : '?';
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
        title = (intro.target ? intro.target.full_name : '—') + ' accepted your introduction';
        when = intro.responded_at || intro.created_at;
      } else {
        return null;
      }
    }

    if (unread) item.classList.add('unread');
    item.dataset.unread = unread ? 'true' : 'false';

    var avatar = el('div', 'inbox-avatar');
    avatar.textContent = (avatarSeed || '?').charAt(0).toUpperCase();
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
        loadBrokerQueue(session.user.id),
        loadMyRequests(session.user.id),
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
  function buildAvatar(name) {
    var a = el('div', 'intro-mini-avatar');
    a.textContent = (name || '?').charAt(0).toUpperCase();
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
