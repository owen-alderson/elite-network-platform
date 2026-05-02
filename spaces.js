// spaces.js — public partner-spaces grid pulled from the partner_spaces
// table. Anyone can read (RLS opens SELECT to anon for this table since
// it's pure marketing content).

(function () {
  if (!window.aether || !window.aether.client) return;
  var supabase = window.aether.client;

  (async function init() {
    var grid = document.getElementById('spaces-grid');
    if (!grid) return;

    var res = await supabase
      .from('partner_spaces')
      .select('id, name, slug, city, country, description, status, is_founding_partner, image_url')
      .neq('status', 'inactive')
      .order('is_founding_partner', { ascending: false })
      .order('status', { ascending: true })   // confirmed before prospective
      .order('city', { ascending: true });

    if (res.error) {
      console.error('spaces load error:', res.error);
      grid.innerHTML = '<p class="spaces-empty">Could not load partner spaces.</p>';
      return;
    }
    var rows = res.data || [];
    grid.innerHTML = '';
    if (!rows.length) {
      grid.innerHTML = '<p class="spaces-empty">Partner roster coming soon.</p>';
      return;
    }
    rows.forEach(function (s) { grid.appendChild(buildCard(s)); });
  })();

  function buildCard(s) {
    // Slug → detail page map. Slugs without an entry render as plain divs.
    var detailPages = {
      'spring-place-ny': 'venue-spring-place.html',
      'spring-place-la': 'venue-spring-place-la.html'
    };
    var detailHref = detailPages[s.slug] || null;
    var node = document.createElement(detailHref ? 'a' : 'div');
    node.className = 'space-card';
    if (detailHref) node.href = detailHref;

    var img = document.createElement('div');
    img.className = 'space-img';
    if (s.image_url) {
      img.style.backgroundImage = 'url(' + s.image_url + ')';
      img.style.backgroundSize = 'cover';
      img.style.backgroundPosition = 'center';
      img.textContent = '';
    } else {
      img.textContent = (s.name || 'AETHER').toUpperCase();
    }
    node.appendChild(img);

    var body = document.createElement('div');
    body.className = 'space-body';

    var city = document.createElement('p');
    city.className = 'space-city';
    city.textContent = s.city || '—';
    body.appendChild(city);

    var name = document.createElement('h3');
    name.className = 'space-name';
    name.textContent = s.name + (s.status === 'prospective' ? ' — TBC' : '');
    body.appendChild(name);

    if (s.is_founding_partner) {
      var founding = document.createElement('span');
      founding.className = 'space-tag';
      founding.textContent = 'Founding partner';
      body.appendChild(founding);
    } else if (s.status === 'prospective') {
      var prosp = document.createElement('span');
      prosp.className = 'space-tag space-tag-prospective';
      prosp.textContent = 'In discussion';
      body.appendChild(prosp);
    }

    if (s.description) {
      var desc = document.createElement('p');
      desc.className = 'space-desc';
      // Show only first paragraph in the grid card.
      desc.textContent = s.description.split('\n\n')[0];
      body.appendChild(desc);
    }

    node.appendChild(body);
    return node;
  }
})();
