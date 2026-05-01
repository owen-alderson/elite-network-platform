// ── Mobile nav toggle ─────────────────────────────────────────
function toggleMenu() {
  const menu = document.getElementById('mobile-menu');
  const ham  = document.getElementById('hamburger');
  if (!menu) return;
  const open = menu.classList.toggle('open');
  ham.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeMenu() {
  const menu = document.getElementById('mobile-menu');
  const ham  = document.getElementById('hamburger');
  if (!menu || !menu.classList.contains('open')) return;
  menu.classList.remove('open');
  if (ham) ham.classList.remove('open');
  document.body.style.overflow = '';
}

// Close on outside click
document.addEventListener('click', function(e) {
  const menu = document.getElementById('mobile-menu');
  const ham  = document.getElementById('hamburger');
  if (!menu || !menu.classList.contains('open')) return;
  if (!menu.contains(e.target) && !ham.contains(e.target)) {
    closeMenu();
  }
});

// Close when any link or button inside the menu is tapped — covers
// page navigations, in-page hash anchors, and sign-out alike. Without
// this the menu lingers open during the navigation transition.
document.addEventListener('click', function(e) {
  const menu = document.getElementById('mobile-menu');
  if (!menu || !menu.classList.contains('open')) return;
  const tappable = e.target.closest('a, button');
  if (tappable && menu.contains(tappable)) closeMenu();
});
