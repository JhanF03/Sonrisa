/* Aplica el tema guardado (o el del sistema) antes de pintar, para evitar destellos. */
(function applyInitialTheme() {
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('agenda.theme'); } catch { /* sin almacenamiento */ }
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = savedTheme || (prefersDark ? 'dark' : 'light');
})();
