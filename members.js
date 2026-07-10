// members.js — live member directory.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.maia || !window.maia.client) return;
  var supabase = window.maia.client;

  var gridEl = document.getElementById('members-grid');
  var toolbarEl = document.querySelector('.filter-list');
  var searchEl = document.getElementById('members-search');

  // <=640px: the site-wide 16px input floor (iOS zoom rule) makes the long
  // NL-search placeholder overflow the input; swap in the short form.
  if (searchEl && window.matchMedia('(max-width: 640px)').matches) {
    searchEl.placeholder = 'Try “models in Milan”…';
  }
  var allMembers = [];
  var activeFilter = 'all';
  var searchTerm = '';

  (async function init() {
    var session = await window.maia.requireAuth();
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
      .select('id,full_name,headline,bio,primary_pillar,secondary_pillars,tags,location_city,location_country,travel_city,travel_country,current_work,avatar_url,joined_at,last_seen_at')
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

    var query = parseQuery(searchTerm);
    updateSearchHint(query);

    var scored = [];
    allMembers.forEach(function (m, i) {
      var pillarMatch = activeFilter === 'all' ||
        (m.primary_pillar || '').toLowerCase() === activeFilter;
      if (!pillarMatch) return;
      var score = scoreMember(m, query);
      if (score < 0) return;
      // joined_at DESC order from the query is the tiebreaker.
      scored.push({ m: m, score: score, order: i });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.order - b.order; });

    if (!scored.length) {
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

    scored.forEach(function (s) { gridEl.appendChild(buildCard(s.m)); });
  }

  function buildCard(m) {
    var card = document.createElement('div');
    card.className = 'member-card';
    card.dataset.pillar = (m.primary_pillar || '').toLowerCase();

    var link = document.createElement('a');
    link.href = 'profile.html?id=' + encodeURIComponent(m.id);

    var avatar = document.createElement('div');
    avatar.className = 'card-avatar';
    window.maia.fillAvatar(avatar, m);
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
    if (m.travel_city && m.travel_city !== m.location_city) displayed.push('Now in ' + m.travel_city);
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
    return s.split(/[_\s]+/).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // ── Natural-language search ─────────────────────────────────
  // "top models in milan" → pillar: fashion, place: milan. The query is
  // decomposed into pillar signals (via a synonym map), place signals
  // (matched against cities/countries members actually have, travel
  // location included), and free-text tokens. Pillar + place act as hard
  // filters when present; free tokens must all hit somewhere in the
  // member's text. Results rank by how strongly they match.

  var PILLAR_SYNONYMS = {
    academia: ['academia', 'academic', 'academics', 'professor', 'professors', 'researcher', 'researchers', 'scholar', 'scholars', 'education', 'educator', 'educators', 'university', 'phd'],
    art: ['art', 'arts', 'artist', 'artists', 'curator', 'curators', 'gallerist', 'gallerists', 'gallery', 'painter', 'painters', 'sculptor', 'sculptors'],
    beauty: ['beauty', 'skincare', 'cosmetics', 'makeup', 'fragrance'],
    entertainment: ['entertainment', 'actor', 'actors', 'actress', 'actresses', 'film', 'films', 'tv', 'television', 'director', 'directors', 'producer', 'producers', 'showrunner'],
    entrepreneurship: ['entrepreneurship', 'entrepreneur', 'entrepreneurs', 'founder', 'founders', 'startup', 'startups', 'operator', 'operators', 'builder', 'builders'],
    fashion: ['fashion', 'model', 'models', 'modeling', 'modelling', 'designer', 'designers', 'stylist', 'stylists', 'couture'],
    finance: ['finance', 'financier', 'financiers', 'banker', 'bankers', 'banking', 'fund', 'funds', 'hedge', 'trader', 'traders'],
    hospitality: ['hospitality', 'hotelier', 'hoteliers', 'hotel', 'hotels', 'restaurateur', 'restaurateurs', 'restaurant', 'restaurants', 'chef', 'chefs'],
    investment: ['investment', 'investing', 'investor', 'investors', 'vc', 'vcs', 'angel', 'angels', 'allocator', 'allocators', 'capital'],
    music: ['music', 'musician', 'musicians', 'singer', 'singers', 'songwriter', 'songwriters', 'dj', 'djs', 'producer', 'producers', 'label', 'artist', 'artists'],
    sport: ['sport', 'sports', 'athlete', 'athletes', 'olympian', 'olympians', 'champion', 'champions', 'player', 'players', 'footballer', 'skier', 'sprinter'],
    wellness: ['wellness', 'longevity', 'health', 'nutrition', 'nutritionist', 'fitness', 'wellbeing', 'mindfulness']
  };

  // token → [pillars] (a word like "producer" or "artist" maps to several)
  var TOKEN_TO_PILLARS = (function () {
    var map = {};
    Object.keys(PILLAR_SYNONYMS).forEach(function (p) {
      PILLAR_SYNONYMS[p].forEach(function (w) {
        if (!map[w]) map[w] = [];
        map[w].push(p);
      });
    });
    return map;
  })();

  var STOPWORDS = {
    top: 1, best: 1, leading: 1, great: 1, the: 1, a: 1, an: 1, of: 1, in: 1,
    at: 1, on: 1, from: 1, based: 1, who: 1, that: 1, are: 1, is: 1, was: 1,
    people: 1, person: 1, members: 1, member: 1, someone: 1, anybody: 1,
    anyone: 1, find: 1, me: 1, my: 1, show: 1, list: 1, 'for': 1, and: 1,
    or: 1, near: 1, around: 1, currently: 1, now: 1, 'with': 1, looking: 1,
    all: 1, any: 1, working: 1, living: 1
  };

  function parseQuery(raw) {
    var q = { pillars: {}, hasPillar: false, places: [], free: [], raw: raw || '' };
    var lower = (raw || '').toLowerCase().trim();
    if (!lower) return q;

    // Multi-word + single-word place detection against places members
    // actually have (home city/country + travel city/country). Matched
    // place words are consumed so they don't fall through to free text.
    var consumed = lower;
    var seenPlace = {};
    allMembers.forEach(function (m) {
      [m.location_city, m.location_country, m.travel_city, m.travel_country].forEach(function (p) {
        if (!p) return;
        var pl = String(p).toLowerCase();
        if (seenPlace[pl]) return;
        if (consumed.indexOf(pl) !== -1) {
          seenPlace[pl] = true;
          q.places.push(pl);
          consumed = consumed.split(pl).join(' ');
        }
      });
    });

    consumed.replace(/[^\w\s]/g, ' ').split(/\s+/).forEach(function (t) {
      if (!t || STOPWORDS[t]) return;
      var mapped = TOKEN_TO_PILLARS[t];
      if (mapped) {
        mapped.forEach(function (p) { q.pillars[p] = true; });
        q.hasPillar = true;
      } else {
        q.free.push(t);
      }
    });
    return q;
  }

  // Returns a relevance score, or -1 to exclude the member.
  function scoreMember(m, q) {
    if (!q.raw) return 0;
    var score = 0;

    if (q.hasPillar) {
      var pillarHit = (m.primary_pillar && q.pillars[m.primary_pillar.toLowerCase()]) ||
        (Array.isArray(m.secondary_pillars) && m.secondary_pillars.some(function (p) {
          return q.pillars[String(p).toLowerCase()];
        }));
      if (!pillarHit) return -1;
      score += 3;
    }

    if (q.places.length) {
      var home = [m.location_city, m.location_country].filter(Boolean).join(' ').toLowerCase();
      var travel = [m.travel_city, m.travel_country].filter(Boolean).join(' ').toLowerCase();
      var travelHit = q.places.some(function (p) { return travel.indexOf(p) !== -1; });
      var homeHit = q.places.some(function (p) { return home.indexOf(p) !== -1; });
      if (!travelHit && !homeHit) return -1;
      // "Who is in Milan" should surface the member traveling there this
      // week above the member who lists it as home but is elsewhere.
      score += travelHit ? 4 : 3;
    }

    if (q.free.length) {
      var hay = [
        m.full_name, m.headline, m.bio, m.current_work,
        m.location_city, m.location_country, m.travel_city,
        m.primary_pillar ? m.primary_pillar.replace(/_/g, ' ') : '',
        Array.isArray(m.tags) ? m.tags.join(' ') : ''
      ].filter(Boolean).join(' ').toLowerCase();
      var hits = 0;
      q.free.forEach(function (t) { if (hay.indexOf(t) !== -1) hits++; });
      // All free tokens must land somewhere (AND), so "melanie okuneye"
      // and "fintech founder milan" both behave predictably.
      if (hits < q.free.length) return -1;
      score += hits;
    }

    return score;
  }

  // Small line under the search box showing what the query was understood
  // as — the difference between search feeling smart and feeling random.
  function updateSearchHint(q) {
    var hint = document.getElementById('members-search-hint');
    if (!hint) return;
    var parts = [];
    if (q.hasPillar) {
      parts.push(Object.keys(q.pillars).map(capitalize).join(' or '));
    }
    if (q.places.length) {
      parts.push('in ' + q.places.map(capitalize).join(', '));
    }
    if (!parts.length) {
      hint.textContent = '';
      hint.style.display = 'none';
      return;
    }
    hint.textContent = 'Showing: ' + parts.join(' · ');
    hint.style.display = 'block';
  }
})();
