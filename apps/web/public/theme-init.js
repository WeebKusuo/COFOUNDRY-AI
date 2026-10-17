// Applies the saved or system colour theme before React renders, avoiding a flash.
(function () {
  var pref = 'system';
  try {
    pref = window.localStorage.getItem('cofoundry-theme') || 'system';
  } catch {
    /* storage unavailable: fall back to the system preference */
  }
  var dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
