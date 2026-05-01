// profile.js — render member profile (own or by ?id=) with edit mode for self.
// Requires supabase.js + auth.js + intro.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  var EDITABLE_FIELDS = [
    'full_name',
    'headline',
    'bio',
    'location_city',
    'location_country',
    'current_work',
    'linkedin_url',
    'instagram_handle',
    'website_url'
  ];

  // Pillar list mirrors the directory + apply form. Owen is the source of truth.
  var ALL_PILLARS = [
    'finance', 'real_estate', 'technology', 'media',
    'hospitality', 'arts', 'sport', 'medicine', 'law'
  ];

  // Single source of truth for the loaded member record.
  var current = null;
  var isOwn = false;
  var sessionUserId = null;

  (async function init() {
    var session = await window.aether.requireAuth();
    if (!session) return;
    sessionUserId = session.user.id;

    var params = new URLSearchParams(window.location.search);
    var paramId = params.get('id');
    var targetId = paramId || sessionUserId;
    isOwn = (targetId === sessionUserId);

    await load(targetId, session.user.email);
    bindActions();
  })();

  async function load(targetId, fallbackEmail) {
    var res = await supabase
      .from('members')
      .select('id,email,full_name,headline,bio,primary_pillar,secondary_pillars,location_city,location_country,linkedin_url,instagram_handle,website_url,avatar_url,achievements,current_work,joined_at,nominated_by,status')
      .eq('id', targetId)
      .maybeSingle();

    if (res.error) {
      console.error('profile load error:', res.error);
      renderError('Could not load profile.');
      return;
    }
    if (!res.data) {
      // Own profile may not exist yet (admin hasn't created the row after invite).
      if (isOwn) {
        renderError('Your profile hasn\'t been set up yet. An admin will create it after approving your invitation.');
      } else {
        renderError('Member not found.');
      }
      return;
    }

    current = res.data;
    renderView();
  }

  function renderView() {
    var m = current;
    setTitle(m.full_name || 'Member');

    var photoEl = document.getElementById('profile-photo');
    if (photoEl) window.aether.fillAvatar(photoEl, m);
    setText('#profile-name', formatName(m.full_name));
    setText('#profile-tagline', m.bio || m.headline || '');
    setText('#profile-pillar-badge', m.primary_pillar ? '◈ ' + capitalize(m.primary_pillar) : '');

    setMeta('location', joinNonEmpty([m.location_city, m.location_country], ', ') || '—');
    setMeta('member_since', m.joined_at ? new Date(m.joined_at).getFullYear() : '—');
    setMeta('pillar', m.primary_pillar ? capitalize(m.primary_pillar) : '—');
    setMeta('nominated_by', m.nominated_by ? 'Member' : 'Private');

    renderAchievements(m.achievements);
    setText('#profile-current-work', m.current_work || '—');
    renderLinks(m);

    setActionsMode(isOwn ? 'self' : 'other');
  }

  function renderLinks(m) {
    var main = document.querySelector('.profile-main');
    if (!main) return;
    var prev = document.getElementById('profile-links');
    if (prev) prev.remove();
    var links = [];
    if (m.linkedin_url) links.push({ href: m.linkedin_url, label: 'LinkedIn' });
    if (m.instagram_handle) {
      var handle = m.instagram_handle.replace(/^@/, '');
      links.push({ href: 'https://instagram.com/' + handle, label: '@' + handle });
    }
    if (m.website_url) {
      var label = m.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      links.push({ href: m.website_url, label: label });
    }
    if (!links.length) return;

    var wrap = document.createElement('div');
    wrap.id = 'profile-links';
    wrap.style.marginTop = '24px';

    var hr = document.createElement('hr');
    hr.className = 'profile-divider';
    wrap.appendChild(hr);

    var label = document.createElement('p');
    label.className = 'profile-section-label';
    label.textContent = 'Links';
    wrap.appendChild(label);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-wrap:wrap; gap:14px; margin-top:8px;';
    links.forEach(function (l) {
      var a = document.createElement('a');
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'color:var(--gold); border-bottom:1px solid var(--gold-dim); font-size:13px;';
      a.textContent = l.label;
      list.appendChild(a);
    });
    wrap.appendChild(list);
    main.appendChild(wrap);
  }

  function renderAchievements(list) {
    var ul = document.getElementById('profile-achievements');
    if (!ul) return;
    ul.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      var li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'No verified achievements yet.';
      ul.appendChild(li);
      return;
    }
    list.forEach(function (a) {
      var li = document.createElement('li');
      var year = document.createElement('span');
      year.className = 'ach-year';
      year.textContent = a.year || '';
      li.appendChild(year);
      var text = document.createElement('span');
      text.className = 'ach-text';
      var strong = document.createElement('strong');
      strong.textContent = a.title || '';
      text.appendChild(strong);
      if (a.details) text.appendChild(document.createTextNode(' — ' + a.details));
      li.appendChild(text);
      ul.appendChild(li);
    });
  }

  function renderError(msg) {
    var main = document.querySelector('.profile-main');
    if (!main) return;
    main.innerHTML = '<p style="color:var(--muted);font-size:14px;padding:40px 0;">' + escapeHtml(msg) + '</p>';
    var sidebar = document.querySelector('.profile-sidebar');
    if (sidebar) sidebar.style.display = 'none';
  }

  function bindActions() {
    var editBtn = document.getElementById('profile-edit-btn');
    var saveBtn = document.getElementById('profile-save-btn');
    var cancelBtn = document.getElementById('profile-cancel-btn');
    var introBtn = document.getElementById('profile-intro-btn');

    if (editBtn) editBtn.addEventListener('click', enterEditMode);
    if (cancelBtn) cancelBtn.addEventListener('click', exitEditMode);
    if (saveBtn) saveBtn.addEventListener('click', saveEdits);
    if (introBtn) introBtn.addEventListener('click', function () {
      if (!current) return;
      window.aetherIntro.open(current.full_name || 'Member', current.id);
    });
  }

  // ── Edit mode ───────────────────────────────────────────────
  function enterEditMode() {
    if (!isOwn || !current) return;
    setActionsMode('editing');

    insertPhotoUploader();

    swapForInput('#profile-name', 'full_name', current.full_name || '', 'input');
    swapForInput('#profile-tagline', 'bio', current.bio || '', 'textarea');

    swapMetaForInput('location_city', current.location_city || '', 'City');
    swapMetaForInputAt(1, 'location_country', current.location_country || '', 'Country');

    // Headline is currently shown in the sidebar role/tagline. We add it as a
    // dedicated edit row above the bio.
    insertEditRow('headline', 'Headline', current.headline || '', 'input');
    insertEditRow('current_work', 'Currently working on', current.current_work || '', 'textarea');
    insertEditRow('linkedin_url', 'LinkedIn URL', current.linkedin_url || '', 'input');
    insertEditRow('instagram_handle', 'Instagram handle', current.instagram_handle || '', 'input');
    insertEditRow('website_url', 'Website', current.website_url || '', 'input');

    insertSecondaryPillarsEditor(current.secondary_pillars || []);
    insertAchievementsEditor(current.achievements || []);
  }

  function insertPhotoUploader() {
    if (document.getElementById('profile-photo-upload')) return;

    var photo = document.getElementById('profile-photo');
    if (!photo || !photo.parentNode) return;

    var wrap = document.createElement('div');
    wrap.id = 'profile-photo-upload';
    wrap.className = 'profile-photo-upload';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost btn-sm';
    btn.textContent = current && current.avatar_url ? 'Replace photo' : 'Upload photo';

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';

    var status = document.createElement('p');
    status.className = 'profile-photo-status';

    btn.addEventListener('click', function () { input.click(); });

    input.addEventListener('change', async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        status.textContent = 'File must be under 5 MB.';
        status.style.color = '#d97a7a';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      status.textContent = '';

      var url = await window.aether.uploadAvatar(sessionUserId, file);
      btn.disabled = false;

      if (!url) {
        btn.textContent = 'Try again';
        status.textContent = 'Upload failed.';
        status.style.color = '#d97a7a';
        return;
      }

      // Refresh local state + re-render the photo immediately.
      current.avatar_url = url;
      var photoEl = document.getElementById('profile-photo');
      if (photoEl) window.aether.fillAvatar(photoEl, current);
      btn.textContent = 'Replace photo';
      status.textContent = 'Photo updated.';
      status.style.color = 'var(--gold)';
    });

    wrap.appendChild(btn);
    wrap.appendChild(input);
    wrap.appendChild(status);
    photo.parentNode.insertBefore(wrap, photo.nextSibling);
  }

  function insertSecondaryPillarsEditor(selected) {
    var anchorRow = document.querySelectorAll('.profile-edit-row');
    var anchor = anchorRow[anchorRow.length - 1];
    if (!anchor) return;

    var row = document.createElement('div');
    row.className = 'profile-edit-row';

    var label = document.createElement('p');
    label.className = 'profile-edit-label';
    label.textContent = 'Secondary pillars';
    row.appendChild(label);

    var hint = document.createElement('p');
    hint.style.cssText = 'font-size:11px;color:var(--muted);margin:0 0 8px;';
    hint.textContent = 'Pick the other fields you operate in. Your primary (' + (current.primary_pillar ? capitalize(current.primary_pillar) : '—') + ') is excluded.';
    row.appendChild(hint);

    var chips = document.createElement('div');
    chips.className = 'profile-pillar-chips';
    chips.dataset.editField = 'secondary_pillars';
    ALL_PILLARS.forEach(function (p) {
      if (p === current.primary_pillar) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'profile-pillar-chip' + (selected.indexOf(p) !== -1 ? ' selected' : '');
      chip.dataset.pillar = p;
      chip.textContent = capitalize(p);
      chip.addEventListener('click', function () { chip.classList.toggle('selected'); });
      chips.appendChild(chip);
    });
    row.appendChild(chips);

    anchor.parentNode.insertBefore(row, anchor.nextSibling);
  }

  function insertAchievementsEditor(items) {
    var rows = document.querySelectorAll('.profile-edit-row');
    var anchor = rows[rows.length - 1];
    if (!anchor) return;

    var row = document.createElement('div');
    row.className = 'profile-edit-row';

    var label = document.createElement('p');
    label.className = 'profile-edit-label';
    label.textContent = 'Achievements';
    row.appendChild(label);

    var list = document.createElement('div');
    list.className = 'profile-ach-list';
    list.dataset.editField = 'achievements';
    row.appendChild(list);

    function addAchRow(a) {
      var achRow = document.createElement('div');
      achRow.className = 'profile-ach-row';

      var year = document.createElement('input');
      year.type = 'text';
      year.className = 'profile-edit-input profile-ach-year';
      year.placeholder = 'Year';
      year.value = (a && a.year) ? String(a.year) : '';

      var title = document.createElement('input');
      title.type = 'text';
      title.className = 'profile-edit-input profile-ach-title';
      title.placeholder = 'Achievement (e.g. 2× Olympic Gold)';
      title.value = (a && a.title) ? a.title : '';

      var details = document.createElement('input');
      details.type = 'text';
      details.className = 'profile-edit-input profile-ach-details';
      details.placeholder = 'Details (optional)';
      details.value = (a && a.details) ? a.details : '';

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'profile-ach-remove';
      rm.title = 'Remove';
      rm.textContent = '✕';
      rm.addEventListener('click', function () { achRow.remove(); });

      achRow.appendChild(year);
      achRow.appendChild(title);
      achRow.appendChild(details);
      achRow.appendChild(rm);
      list.appendChild(achRow);
    }

    (items || []).forEach(addAchRow);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-ghost btn-sm profile-ach-add';
    addBtn.textContent = '+ Add achievement';
    addBtn.addEventListener('click', function () { addAchRow(null); });
    row.appendChild(addBtn);

    anchor.parentNode.insertBefore(row, anchor.nextSibling);
  }

  function exitEditMode() {
    // Easiest: reload the current data and re-render.
    renderView();
  }

  async function saveEdits() {
    var saveBtn = document.getElementById('profile-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    var payload = {};
    EDITABLE_FIELDS.forEach(function (field) {
      var input = document.querySelector('[data-edit-field="' + field + '"]');
      if (!input) return;
      var v = (input.value || '').trim();
      payload[field] = v === '' ? null : v;
    });

    // Secondary pillars: collect selected chips.
    var pillarsBox = document.querySelector('[data-edit-field="secondary_pillars"]');
    if (pillarsBox) {
      var selected = pillarsBox.querySelectorAll('.profile-pillar-chip.selected');
      payload.secondary_pillars = Array.prototype.map.call(selected, function (c) {
        return c.dataset.pillar;
      });
    }

    // Achievements: collect rows that have at least a title.
    var achList = document.querySelector('[data-edit-field="achievements"]');
    if (achList) {
      var rows = achList.querySelectorAll('.profile-ach-row');
      payload.achievements = Array.prototype.map.call(rows, function (r) {
        return {
          year: (r.querySelector('.profile-ach-year').value || '').trim(),
          title: (r.querySelector('.profile-ach-title').value || '').trim(),
          details: (r.querySelector('.profile-ach-details').value || '').trim()
        };
      }).filter(function (a) { return a.title; });
    }

    var res = await supabase
      .from('members')
      .update(payload)
      .eq('id', sessionUserId)
      .select()
      .single();

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }

    if (res.error) {
      console.error('profile save error:', res.error);
      alert('Could not save: ' + (res.error.message || 'unknown error'));
      return;
    }

    current = res.data || Object.assign({}, current, payload);
    renderView();
  }

  function swapForInput(selector, field, value, kind) {
    var el = document.querySelector(selector);
    if (!el) return;
    var input = (kind === 'textarea') ? document.createElement('textarea') : document.createElement('input');
    if (kind === 'input') input.type = 'text';
    if (kind === 'textarea') { input.rows = 3; }
    input.className = 'profile-edit-input';
    input.value = value;
    input.dataset.editField = field;
    el.replaceWith(input);
    // Preserve the original ID on the input so re-render finds the right node
    // — but on save we re-render from scratch, so identifying via dataset is enough.
  }

  function swapMetaForInput(field, value, placeholder) {
    var el = document.querySelector('[data-field="' + field + '"]');
    if (!el) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder || '';
    input.className = 'profile-edit-input profile-edit-input-sm';
    input.dataset.editField = field;
    el.replaceWith(input);
  }

  // For meta-items that don't yet have a data-field (e.g. country sits next to city),
  // we look up by adjacent label text.
  function swapMetaForInputAt(_unused, field, value, placeholder) {
    // location_country isn't on its own line currently — append it as a new edit row
    // below the city input.
    var cityInput = document.querySelector('[data-edit-field="location_city"]');
    if (!cityInput) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder || '';
    input.className = 'profile-edit-input profile-edit-input-sm';
    input.dataset.editField = field;
    input.style.marginTop = '6px';
    cityInput.parentNode.insertBefore(input, cityInput.nextSibling);
  }

  function insertEditRow(field, labelText, value, kind) {
    var anchor = document.querySelector('[data-edit-field="bio"]');
    if (!anchor) return;
    var row = document.createElement('div');
    row.className = 'profile-edit-row';
    var label = document.createElement('p');
    label.className = 'profile-edit-label';
    label.textContent = labelText;
    row.appendChild(label);
    var input = (kind === 'textarea') ? document.createElement('textarea') : document.createElement('input');
    if (kind === 'input') input.type = 'text';
    if (kind === 'textarea') input.rows = 3;
    input.className = 'profile-edit-input';
    input.value = value;
    input.dataset.editField = field;
    row.appendChild(input);
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
  }

  // ── Action button visibility ────────────────────────────────
  function setActionsMode(mode) {
    var actions = document.getElementById('profile-actions');
    if (!actions) return;
    actions.dataset.state = mode; // 'self' | 'other' | 'editing'
  }

  // ── small helpers ──────────────────────────────────────────
  function setText(selector, text) {
    var el = document.querySelector(selector);
    if (el) el.textContent = text == null ? '' : String(text);
  }
  function setMeta(field, text) {
    var el = document.querySelector('[data-field="' + field + '"]');
    if (el) el.textContent = text == null ? '' : String(text);
  }
  function setTitle(name) {
    document.title = name + ' — Aether';
  }
  function initial(s) {
    return (s || '?').trim().charAt(0).toUpperCase();
  }
  function formatName(s) {
    if (!s) return '—';
    var parts = s.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(' ') + '\n' + parts[parts.length - 1];
  }
  function joinNonEmpty(arr, sep) {
    return (arr || []).filter(Boolean).join(sep);
  }
  function capitalize(s) {
    if (!s) return s;
    return s.split('_').map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
})();
