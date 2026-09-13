(function () {
  var theme = 'light';
  try {
    var saved = localStorage.getItem('yelou-theme');
    if (saved === 'dark' || saved === 'light') theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme);
})();
