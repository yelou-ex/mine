(function () {
  var STORAGE_KEY = 'yelou-theme';

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    try { localStorage.setItem(STORAGE_KEY, theme === 'dark' ? 'dark' : 'light'); } catch (e) {}
  }

  function current() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  apply(current());

  document.addEventListener('DOMContentLoaded', function () {
    var switchInput = document.querySelector('.theme-switch input');
    if (!switchInput) return;
    switchInput.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    switchInput.addEventListener('change', function () {
      apply(this.checked ? 'dark' : 'light');
    });
  });
})();
