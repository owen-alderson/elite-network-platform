// admin.js — application review queue.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.aether || !window.aether.client) {
    console.error('admin.js: supabase.js must load first');
    return;
  }
  var supabase = window.aether.client;

  var listEl = document.getElementById('admin-list');
  var tabsEl = document.querySelector('.admin-tabs');
  var statEls = {
    pending: document.getElementById('stat-pending'),
    approved: document.getElementById('stat-approved'),
    rejected: document.getElementById('stat-rejected'),
    needs_more_info: document.getElementById('stat-needsinfo')
  };
  var currentFilter = 'pending';

  // ── Boot ────────────────────────────────────────────────────
  (async function init() {
    var session = await window.aether.requireAdmin();
    if (!session) return;

    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-tab');
      if (!btn) return;
      currentFilter = btn.dataset.status;
      tabsEl.querySelectorAll('.admin-tab').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      render();
    });

    await refresh();
  })();

  async function refresh() {
    await Promise.all([loadStats(), render()]);
  }

  async function loadStats() {
    var keys = Object.keys(statEls);
    await Promise.all(keys.map(async function (status) {
      var res = await supabase
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      var el = statEls[status];
      if (!el) return;
      el.textContent = res.error ? '?' : (res.count != null ? res.count : '0');
    }));
  }

  async function render() {
    listEl.innerHTML = '<p class="admin-loading">Loading…</p>';

    var query = supabase
      .from('applications')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (currentFilter !== 'all') query = query.eq('status', currentFilter);

    var res = await query;
    listEl.innerHTML = '';

    if (res.error) {
      var err = document.createElement('p');
      err.className = 'admin-empty';
      err.textContent = 'Could not load applications: ' + res.error.message;
      listEl.appendChild(err);
      return;
    }
    if (!res.data || !res.data.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'No applications in this view.';
      listEl.appendChild(empty);
      return;
    }

    res.data.forEach(function (app) {
      listEl.appendChild(buildCard(app));
    });
  }

  // ── Card builder (createElement + textContent everywhere — XSS-safe) ──
  function buildCard(app) {
    var article = el('article', 'app-card');
    article.dataset.id = app.id;

    article.appendChild(buildCardHead(app));
    article.appendChild(buildCardBody(app));
    article.appendChild(buildCardFoot(app));

    return article;
  }

  function buildCardHead(app) {
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
    var statusEl = text('span', 'app-status app-status-' + app.status, prettyStatus(app.status));
    right.appendChild(statusEl);
    right.appendChild(text('p', 'app-card-date', formatDate(app.submitted_at)));
    head.appendChild(right);

    return head;
  }

  function buildCardBody(app) {
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

  function buildCardFoot(app) {
    if (app.status === 'pending' || app.status === 'needs_more_info') {
      return buildActionFoot(app);
    }
    var foot = el('footer', 'app-card-review-meta');
    var line = 'Reviewed ' + formatDate(app.reviewed_at);
    if (app.reviewer_notes) line += ' · ' + app.reviewer_notes;
    foot.textContent = line;
    return foot;
  }

  function buildActionFoot(app) {
    var foot = el('footer', 'app-card-actions');

    var notes = document.createElement('textarea');
    notes.className = 'app-notes';
    notes.placeholder = 'Reviewer notes (optional, visible only to admins)…';
    notes.value = app.reviewer_notes || '';
    foot.appendChild(notes);

    var btnRow = el('div', 'app-action-buttons');
    btnRow.appendChild(actionBtn('Needs info', 'needs_more_info', 'btn-ghost btn-sm', app.id, notes));
    btnRow.appendChild(actionBtn('Reject', 'rejected', 'btn-ghost btn-sm app-btn-reject', app.id, notes));
    btnRow.appendChild(actionBtn('Approve', 'approved', 'btn-primary btn-sm', app.id, notes));
    foot.appendChild(btnRow);

    return foot;
  }

  function actionBtn(label, status, classes, appId, notesEl) {
    var btn = document.createElement('button');
    btn.className = classes;
    btn.textContent = label;
    btn.addEventListener('click', async function () {
      if (status === 'rejected' && !confirm('Reject this application?')) return;
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
      await refresh();
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

  function divider() {
    return el('hr', 'app-divider');
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
