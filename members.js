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
      .select('id,full_name,headline,primary_pillar,location_city,location_country,secondary_pillars')
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
      return (m.full_name || '').toLowerCase().indexOf(searchTerm) !== -1 ||
             (m.headline || '').toLowerCase().indexOf(searchTerm) !== -1;
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
    avatar.textContent = (m.full_name || '?').charAt(0).toUpperCase();
    link.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'card-body';

    if (m.primary_pillar) {
      var pillar = document.createElement('p');
      pillar.className = 'card-pillar';
      pillar.textContent = capitalize(m.primary_pillar);
      body.appendChild(pillar);
    }

    var name = document.createElement('h3');
    name.className = 'card-name';
    name.textContent = m.full_name || '—';
    body.appendChild(name);

    if (m.headline) {
      var title = document.createElement('p');
      title.className = 'card-title';
      title.textContent = m.headline;
      body.appendChild(title);
    }

    var tagWrap = document.createElement('div');
    tagWrap.className = 'card-tags';
    var tags = [];
    if (Array.isArray(m.secondary_pillars)) tags = tags.concat(m.secondary_pillars);
    if (m.location_city) tags.push(m.location_city);
    tags.slice(0, 3).forEach(function (t) {
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

  function capitalize(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
})();
