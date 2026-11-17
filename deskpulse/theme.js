// Apply the saved / system theme before first paint (avoids a light-mode flash).
(function () {
    try {
        var saved = localStorage.getItem('deskpulse_theme');
        var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('dark', dark);
    } catch (e) { /* storage unavailable: keep the default light theme */ }
})();
