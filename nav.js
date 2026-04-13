// ── Mobile nav toggle ─────────────────────────────────────────
function toggleMenu() {
  const menu = document.getElementById('mobile-menu');
  const ham  = document.getElementById('hamburger');
  if (!menu) return;
  const open = menu.classList.toggle('open');
  ham.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

// Close on outside click
document.addEventListener('click', function(e) {
  const menu = document.getElementById('mobile-menu');
  const ham  = document.getElementById('hamburger');
  if (!menu || !menu.classList.contains('open')) return;
  if (!menu.contains(e.target) && !ham.contains(e.target)) {
    menu.classList.remove('open');
    ham.classList.remove('open');
    document.body.style.overflow = '';
  }
});
