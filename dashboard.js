// dashboard.js — populate the logged-in home view with live member data.
// Requires supabase.js + auth.js + intro.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;
    await Promise.all([
      loadMyProfile(session.user.id, session.user.email),
      loadSuggestedConnections(session.user.id)
    ]);
  })();

  async function loadMyProfile(userId, fallbackEmail) {
    var res = await supabase
      .from('members')
      .select('full_name,headline,primary_pillar')
      .eq('id', userId)
      .maybeSingle();

    if (res.error) {
      console.error('loadMyProfile error:', res.error);
    }

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
    if (pillarTag) {
      pillarTag.textContent = pillar ? '◈ ' + capitalize(pillar) : '◈ —';
    }

    setText('.dash-greeting-head', greeting() + ', ' + firstName + '.');
    setText('.dash-greeting-sub', 'Welcome back. Browse the directory or explore what\'s on at Spring Place.');
  }

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

    if (res.error) {
      console.error('loadSuggestedConnections error:', res.error);
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">Could not load suggestions.</p>';
      return;
    }

    listEl.innerHTML = '';
    if (!res.data || !res.data.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">No other members yet — once your cohort joins, they\'ll appear here.</p>';
      return;
    }

    res.data.forEach(function (m) {
      listEl.appendChild(buildSuggestionRow(m));
    });
  }

  function buildSuggestionRow(m) {
    var row = document.createElement('div');
    row.className = 'suggestion-row';

    var avatar = document.createElement('div');
    avatar.className = 'sug-avatar';
    avatar.textContent = (m.full_name || '?').charAt(0).toUpperCase();
    row.appendChild(avatar);

    var info = document.createElement('div');
    info.className = 'sug-info';

    var nameLink = document.createElement('a');
    nameLink.href = 'profile.html?id=' + encodeURIComponent(m.id);
    nameLink.className = 'sug-name';
    nameLink.style.color = 'inherit';
    nameLink.style.textDecoration = 'none';
    nameLink.textContent = m.full_name || '—';
    var nameWrap = document.createElement('p');
    nameWrap.className = 'sug-name';
    nameWrap.style.margin = '0';
    nameWrap.appendChild(nameLink);
    info.appendChild(nameWrap);

    var role = document.createElement('p');
    role.className = 'sug-role';
    role.textContent = m.headline || '';
    info.appendChild(role);

    var tagText = [];
    if (m.primary_pillar) tagText.push(capitalize(m.primary_pillar));
    if (m.location_city) tagText.push(m.location_city);
    var tag = document.createElement('span');
    tag.className = 'sug-tag';
    tag.textContent = tagText.join(' · ');
    info.appendChild(tag);

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

  // ── helpers ─────────────────────────────────────────────────
  function setText(selector, text) {
    var el = document.querySelector(selector);
    if (el) el.textContent = text;
  }
  function setHTML(selector, html) {
    var el = document.querySelector(selector);
    if (el) el.innerHTML = html;
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
})();
