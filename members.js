// members.js — live member directory.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  var gridEl = document.getElementById('members-grid');
  var toolbarEl = document.querySelector('.filter-list');
  var searchEl = document.getElementById('members-search');
  var allMembers = [];
  var activeFilter = 'all';
  var searchTerm = '';

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;

    if (toolbarEl) {
      toolbarEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.filter-btn');
        if (!btn) return;
        toolbarEl.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeFilter = btn.dataset.pillar || 'all';
        render();
      });
    }

    if (searchEl) {
      searchEl.addEventListener('input', function (e) {
        searchTerm = (e.target.value || '').trim().toLowerCase();
        render();
      });
    }

    await load();
  })();

  async function load() {
    if (!gridEl) return;
    gridEl.innerHTML = '<p style="color:var(--muted);grid-column:1/-1;text-align:center;padding:40px 0;">Loading members…</p>';

    var res = await supabase
      .from('members')
      .select('id,full_name,headline,bio,primary_pillar,secondary_pillars,tags,location_city,location_country,current_work,avatar_url,joined_at,last_seen_at')
      .eq('status', 'active')
      .order('joined_at', { ascending: false });

    if (res.error) {
      console.error('members load error:', res.error);
      gridEl.innerHTML = '<p style="color:var(--muted);grid-column:1/-1;text-align:center;padding:40px 0;">Could not load members.</p>';
      return;
    }

    allMembers = res.data || [];
    render();
  }

  function render() {
    if (!gridEl) return;
    gridEl.innerHTML = '';

    var filtered = allMembers.filter(function (m) {
      var pillarMatch = activeFilter === 'all' ||
        (m.primary_pillar || '').toLowerCase() === activeFilter;
      if (!pillarMatch) return false;
      if (!searchTerm) return true;
      return matchesSearch(m, searchTerm);
    });

    if (!filtered.length) {
      var empty = document.createElement('p');
      empty.style.cssText = 'color:var(--muted);grid-column:1/-1;text-align:center;padding:40px 0;';
      empty.textContent = searchTerm
        ? 'No members match “' + searchTerm + '”.'
        : (activeFilter === 'all'
            ? 'No members yet.'
            : 'No members in ' + activeFilter + ' yet.');
      gridEl.appendChild(empty);
      return;
    }

    filtered.forEach(function (m) { gridEl.appendChild(buildCard(m)); });
  }

  function buildCard(m) {
    var card = document.createElement('div');
    card.className = 'member-card';
    card.dataset.pillar = (m.primary_pillar || '').toLowerCase();

    var link = document.createElement('a');
    link.href = 'profile.html?id=' + encodeURIComponent(m.id);

    var avatar = document.createElement('div');
    avatar.className = 'card-avatar';
    window.aether.fillAvatar(avatar, m);
    link.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'card-body';

    if (m.primary_pillar) {
      var pillar = document.createElement('p');
      pillar.className = 'card-pillar';
      pillar.textContent = capitalize(m.primary_pillar);
      body.appendChild(pillar);
    }

    var nameRow = document.createElement('div');
    nameRow.className = 'card-name-row';
    var name = document.createElement('h3');
    name.className = 'card-name';
    name.textContent = m.full_name || '—';
    nameRow.appendChild(name);
    if (isActiveToday(m)) {
      var pip = document.createElement('span');
      pip.className = 'card-active-pip';
      pip.title = 'Active in the last 24 hours';
      nameRow.appendChild(pip);
    }
    body.appendChild(nameRow);

    if (m.headline) {
      var title = document.createElement('p');
      title.className = 'card-title';
      title.textContent = m.headline;
      body.appendChild(title);
    }

    if (m.current_work) {
      var next = document.createElement('p');
      next.className = 'card-next';
      next.textContent = m.current_work;
      body.appendChild(next);
    }

    var tagWrap = document.createElement('div');
    tagWrap.className = 'card-tags';
    var displayed = [];
    if (m.location_city) displayed.push(m.location_city);
    if (Array.isArray(m.tags)) displayed = displayed.concat(m.tags);
    displayed.slice(0, 3).forEach(function (t) {
      if (!t) return;
      var span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      tagWrap.appendChild(span);
    });
    if (tagWrap.children.length) body.appendChild(tagWrap);

    link.appendChild(body);
    card.appendChild(link);
    return card;
  }

  // Show the "active today" pip only if the member has had a real session
  // beyond row creation. last_seen_at defaults to now() at row creation, so
  // newly-seeded members would otherwise all show as active. Require a gap
  // of at least 5 minutes between joined_at and last_seen_at to filter that.
  function isActiveToday(m) {
    if (!m.last_seen_at || !m.joined_at) return false;
    var seen = new Date(m.last_seen_at).getTime();
    var joined = new Date(m.joined_at).getTime();
    if (seen - joined < 5 * 60 * 1000) return false;
    return Date.now() - seen < 24 * 60 * 60 * 1000;
  }

  function capitalize(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // Search across every field that's either visible on the card or
  // useful in finding a member: name, headline (role/company), bio,
  // city, country, current focus, and pillars (primary + secondary).
  function matchesSearch(m, term) {
    var parts = [
      m.full_name,
      m.headline,
      m.bio,
      m.location_city,
      m.location_country,
      m.current_work,
      m.primary_pillar ? m.primary_pillar.replace(/_/g, ' ') : '',
      Array.isArray(m.tags) ? m.tags.join(' ') : ''
    ];
    return parts.filter(Boolean).join(' ').toLowerCase().indexOf(term) !== -1;
  }
})();
