// events.js — render upcoming events from the events table.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  var currentWhen = 'upcoming';

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;
    bindToggle();
    await loadEvents();
  })();

  function bindToggle() {
    var btns = document.querySelectorAll('.events-toggle-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', async function () {
        currentWhen = btn.dataset.when || 'upcoming';
        btns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        var title = document.getElementById('events-page-title');
        if (title) title.textContent = currentWhen === 'past' ? 'Past Events' : 'Upcoming Events';
        await loadEvents();
      });
    });
  }

  async function loadEvents() {
    var listEl = document.getElementById('events-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="events-empty">Loading events…</p>';

    var nowIso = new Date().toISOString();
    var query = supabase
      .from('events')
      .select('id, title, description, starts_at, ends_at, location_text, capacity, pillar_focus, visibility, status, image_url, partner_space_id, partner_space:partner_spaces!partner_space_id(image_url, name)');

    if (currentWhen === 'past') {
      query = query.or('status.eq.past,and(status.eq.upcoming,starts_at.lt.' + nowIso + ')')
        .order('starts_at', { ascending: false });
    } else {
      query = query.eq('status', 'upcoming')
        .gte('starts_at', nowIso)
        .order('starts_at', { ascending: true });
    }

    var res = await query;

    listEl.innerHTML = '';
    if (res.error) {
      console.error('Events load error:', res.error);
      listEl.innerHTML = '<p class="events-empty">Could not load events.</p>';
      return;
    }
    if (!res.data || !res.data.length) {
      listEl.innerHTML = '<p class="events-empty">' +
        (currentWhen === 'past'
          ? 'No past events yet — Aether is just getting started.'
          : 'No upcoming events scheduled yet. Check back soon.') +
        '</p>';
      return;
    }

    res.data.forEach(function (ev) { listEl.appendChild(buildEventRow(ev)); });

    // Lazy-load RSVP counts so "X spots remaining" is accurate.
    loadRsvpCounts(res.data);
  }

  function buildEventRow(ev) {
    var row = document.createElement('a');
    row.className = 'event-row';
    row.href = 'event.html?id=' + encodeURIComponent(ev.id);
    row.style.cursor = 'pointer';
    row.style.color = 'inherit';
    row.style.textDecoration = 'none';
    row.dataset.eventId = ev.id;

    var date = new Date(ev.starts_at);

    // Image-with-date overlay block. Custom event image wins; partner-space
    // image is the fallback; if neither, the block falls back to a flat
    // surface tone so the date stays readable.
    var imageUrl = ev.image_url || (ev.partner_space && ev.partner_space.image_url) || null;
    var imageBlock = document.createElement('div');
    imageBlock.className = 'event-image-block';
    if (imageUrl) {
      imageBlock.style.backgroundImage = 'url(' + imageUrl + ')';
      imageBlock.classList.add('has-image');
    }
    var dateBlock = document.createElement('div');
    dateBlock.className = 'event-date-block';
    var day = document.createElement('div');
    day.className = 'event-day';
    day.textContent = date.getDate();
    var month = document.createElement('div');
    month.className = 'event-month';
    month.textContent = date.toLocaleString(undefined, { month: 'short' });
    dateBlock.appendChild(day);
    dateBlock.appendChild(month);
    imageBlock.appendChild(dateBlock);
    row.appendChild(imageBlock);

    var info = document.createElement('div');
    info.className = 'event-info';
    var title = document.createElement('h3');
    title.className = 'event-title';
    title.textContent = ev.title || '—';
    info.appendChild(title);

    var meta = document.createElement('p');
    meta.className = 'event-meta';
    var bits = [];
    if (ev.location_text) bits.push('📍 ' + ev.location_text);
    bits.push(date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }));
    if (Array.isArray(ev.pillar_focus) && ev.pillar_focus.length) {
      bits.push(ev.pillar_focus.map(prettyPillar).join(' · '));
    }
    bits.forEach(function (b) {
      var s = document.createElement('span');
      s.textContent = b;
      meta.appendChild(s);
    });
    info.appendChild(meta);
    row.appendChild(info);

    var tags = document.createElement('div');
    tags.className = 'event-tags';
    var visibilityTag = document.createElement('span');
    visibilityTag.className = 'event-tag';
    visibilityTag.textContent = ev.visibility === 'invite_only' ? 'Invite Only' : 'Members Only';
    tags.appendChild(visibilityTag);

    var spots = document.createElement('span');
    spots.className = 'event-spots';
    spots.dataset.spotsFor = ev.id;
    spots.textContent = ev.capacity ? ev.capacity + ' spots' : 'Open';
    tags.appendChild(spots);
    row.appendChild(tags);

    return row;
  }

  async function loadRsvpCounts(events) {
    var ids = events.filter(function (e) { return e.capacity; }).map(function (e) { return e.id; });
    if (!ids.length) return;
    var res = await supabase
      .from('event_rsvps')
      .select('event_id')
      .eq('status', 'going')
      .in('event_id', ids);
    if (res.error) return;
    var counts = {};
    (res.data || []).forEach(function (r) { counts[r.event_id] = (counts[r.event_id] || 0) + 1; });
    events.forEach(function (e) {
      if (!e.capacity) return;
      var taken = counts[e.id] || 0;
      var remaining = Math.max(0, e.capacity - taken);
      var node = document.querySelector('[data-spots-for="' + e.id + '"]');
      if (node) node.textContent = remaining + ' spots remaining';
    });
  }

  function prettyPillar(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
})();
