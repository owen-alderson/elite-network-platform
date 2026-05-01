// event.js — render one event by ?id=, handle RSVP toggling.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  var currentEventId = null;
  var currentEvent = null;
  var sessionUserId = null;

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;
    sessionUserId = session.user.id;

    var params = new URLSearchParams(window.location.search);
    currentEventId = params.get('id');
    if (!currentEventId) {
      renderError('No event specified.');
      return;
    }
    await loadEvent();
    await loadAttendees();
  })();

  async function loadEvent() {
    var res = await supabase
      .from('events')
      .select('id, title, description, starts_at, ends_at, location_text, capacity, pillar_focus, visibility, status')
      .eq('id', currentEventId)
      .maybeSingle();

    if (res.error || !res.data) {
      console.error('event load error:', res.error);
      renderError('Event not found.');
      return;
    }
    currentEvent = res.data;
    render();
  }

  function render() {
    var ev = currentEvent;
    var starts = new Date(ev.starts_at);

    document.title = (ev.title || 'Event') + ' · Aether';
    setText('.event-hero-day', String(starts.getDate()));
    setText('.event-hero-month', starts.toLocaleString(undefined, { month: 'long', year: 'numeric' }));
    setHTML('.event-hero-title', escapeHtml(ev.title || ''));

    var heroMeta = document.querySelector('.event-hero-meta');
    if (heroMeta) {
      heroMeta.innerHTML = '';
      if (ev.location_text) heroMeta.appendChild(metaSpan('📍 ' + ev.location_text));
      var time = starts.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
      if (ev.ends_at) {
        var ends = new Date(ev.ends_at);
        time += ' – ' + ends.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      heroMeta.appendChild(metaSpan(time));
      if (Array.isArray(ev.pillar_focus) && ev.pillar_focus.length) {
        heroMeta.appendChild(metaSpan(ev.pillar_focus.map(prettyPillar).join(' · ')));
      }
    }

    var descSection = document.querySelector('.event-main .event-section:first-child .event-desc');
    if (descSection) descSection.textContent = ev.description || 'Details coming soon.';
    // Hide the second desc paragraph if present.
    var allDescs = document.querySelectorAll('.event-main .event-section:first-child .event-desc');
    if (allDescs.length > 1) {
      for (var i = 1; i < allDescs.length; i++) allDescs[i].style.display = 'none';
    }

    // Sidebar RSVP card
    var dateLine = starts.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    var timeLine = starts.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (ev.ends_at) timeLine += ' – ' + new Date(ev.ends_at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
    setRsvpDetail('Date', dateLine);
    setRsvpDetail('Time', timeLine);
    setRsvpDetail('Location', ev.location_text || '—');
    setRsvpDetail('Format', capitalizeWords(ev.visibility || 'all_members').replace('_', ' '));

    var dressEl = findRsvpRow('Dress');
    if (dressEl) dressEl.parentNode.removeChild(dressEl);

    // Set up sidebar pillars
    var pillarsBox = document.querySelectorAll('.event-sidebar-tags')[0];
    if (pillarsBox) {
      var tags = pillarsBox.querySelector('.card-tags');
      if (tags) {
        tags.innerHTML = '';
        (ev.pillar_focus || []).forEach(function (p) {
          var s = document.createElement('span');
          s.className = 'tag';
          s.textContent = prettyPillar(p);
          tags.appendChild(s);
        });
        if (!tags.children.length) {
          tags.innerHTML = '<span class="tag">All pillars</span>';
        }
      }
    }

    // Hide "More events" sidebar block — phase 1 keeps it simple.
    var moreEventsBlock = document.querySelectorAll('.event-sidebar-tags')[1];
    if (moreEventsBlock) moreEventsBlock.style.display = 'none';
  }

  async function loadAttendees() {
    var res = await supabase
      .from('event_rsvps')
      .select('member_id, status, members!member_id(id, full_name, primary_pillar, location_city)')
      .eq('event_id', currentEventId)
      .eq('status', 'going');

    var attending = res.error ? [] : (res.data || []);
    renderAttendees(attending);
    var iAmGoing = attending.some(function (r) { return r.member_id === sessionUserId; });
    setupRsvpButton(iAmGoing, attending.length);
  }

  function renderAttendees(rows) {
    var grid = document.querySelector('.attendees-grid');
    var section = grid ? grid.closest('.event-section') : null;
    var blurb = section ? section.querySelector('p[style*="color:var(--muted)"]') : null;

    if (grid) {
      grid.innerHTML = '';
      if (!rows.length) {
        var empty = document.createElement('p');
        empty.style.color = 'var(--muted)';
        empty.style.fontSize = '13px';
        empty.textContent = 'No RSVPs yet. Be the first.';
        grid.appendChild(empty);
      } else {
        rows.slice(0, 7).forEach(function (r) {
          var m = r.members || {};
          var card = document.createElement('a');
          card.className = 'attendee-card';
          card.href = 'profile.html?id=' + encodeURIComponent(m.id);
          card.style.color = 'inherit';
          card.style.textDecoration = 'none';

          var av = document.createElement('div');
          av.className = 'att-avatar-lg';
          av.textContent = (m.full_name || '?').charAt(0).toUpperCase();
          card.appendChild(av);

          var name = document.createElement('p');
          name.className = 'att-name';
          name.textContent = m.full_name || '—';
          card.appendChild(name);

          var field = document.createElement('p');
          field.className = 'att-field';
          var bits = [];
          if (m.primary_pillar) bits.push(prettyPillar(m.primary_pillar));
          if (m.location_city) bits.push(m.location_city);
          field.textContent = bits.join(' · ');
          card.appendChild(field);

          grid.appendChild(card);
        });
        if (rows.length > 7) {
          var more = document.createElement('div');
          more.className = 'attendee-card attendee-anon';
          more.innerHTML = '<div class="att-avatar-lg" style="font-size:18px; color:var(--muted)">+' + (rows.length - 7) + '</div>' +
                           '<p class="att-name" style="color:var(--muted)">More members</p>' +
                           '<p class="att-field">RSVP\'d</p>';
          grid.appendChild(more);
        }
      }
    }

    if (blurb) {
      var capacity = currentEvent.capacity;
      blurb.textContent = rows.length + (rows.length === 1 ? ' confirmed' : ' confirmed') +
        (capacity ? ' · ' + Math.max(0, capacity - rows.length) + ' spots remaining' : '');
    }
  }

  function setupRsvpButton(iAmGoing, attendingCount) {
    var btn = document.getElementById('rsvp-btn');
    if (!btn) return;

    // Replace the inline onclick with our wired handler.
    btn.onclick = null;
    btn.removeAttribute('onclick');

    btn.disabled = false;
    btn.style.opacity = '';
    btn.textContent = iAmGoing ? 'Cancel RSVP' : 'Reserve my place';
    btn.dataset.going = iAmGoing ? 'true' : 'false';

    btn.addEventListener('click', async function () {
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = 'Saving…';

      var err;
      if (btn.dataset.going === 'true') {
        var del = await supabase
          .from('event_rsvps')
          .delete()
          .eq('event_id', currentEventId)
          .eq('member_id', sessionUserId);
        err = del.error;
      } else {
        var ins = await supabase
          .from('event_rsvps')
          .insert({ event_id: currentEventId, member_id: sessionUserId, status: 'going' });
        err = ins.error;
      }

      if (err) {
        console.error('RSVP toggle failed:', err);
        alert('Could not update RSVP: ' + (err.message || 'unknown error'));
        btn.disabled = false;
        btn.textContent = prev;
        return;
      }

      await loadAttendees();
    });

    // Spots remaining (sidebar)
    var spotsNum = document.querySelector('.rsvp-spots-num');
    var spotsLabel = document.querySelector('.rsvp-spots-label');
    if (spotsNum && currentEvent.capacity) {
      var remaining = Math.max(0, currentEvent.capacity - attendingCount);
      spotsNum.textContent = String(remaining);
      if (spotsLabel) spotsLabel.textContent = remaining === 1 ? 'spot remaining' : 'spots remaining';
    } else if (spotsNum) {
      spotsNum.textContent = String(attendingCount);
      if (spotsLabel) spotsLabel.textContent = 'attending';
    }
  }

  function renderError(msg) {
    var hero = document.querySelector('.event-hero-inner');
    if (hero) {
      hero.innerHTML = '<p style="color:var(--muted);">' + escapeHtml(msg) + ' <a href="events.html" style="color:var(--gold);">← All events</a></p>';
    }
    var body = document.querySelector('.event-body-wrap');
    if (body) body.style.display = 'none';
  }

  // ── helpers ────────────────────────────────────────
  function setText(sel, value) {
    var el = document.querySelector(sel);
    if (el) el.textContent = value == null ? '' : String(value);
  }
  function setHTML(sel, value) {
    var el = document.querySelector(sel);
    if (el) el.innerHTML = value;
  }
  function metaSpan(text) {
    var s = document.createElement('span');
    s.textContent = text;
    return s;
  }
  function setRsvpDetail(label, value) {
    var row = findRsvpRow(label);
    if (!row) return;
    var v = row.querySelector('.rsvp-detail-val');
    if (v) v.textContent = value;
  }
  function findRsvpRow(label) {
    var rows = document.querySelectorAll('.rsvp-detail');
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i].querySelector('.rsvp-detail-label');
      if (l && l.textContent.trim() === label) return rows[i];
    }
    return null;
  }
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function prettyPillar(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  function capitalizeWords(s) { return prettyPillar(s); }
})();
