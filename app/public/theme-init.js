// Apply the saved/preferred theme before first paint to avoid a flash.
// External (not inline) so the Content-Security-Policy can stay strict.
;(function () {
  // Light unless the visitor has chosen dark with the toggle.
  var t = 'light'
  try {
    if (localStorage.getItem('sudoku-theme') === 'dark') t = 'dark'
  } catch (e) {
    // Storage unavailable (private mode): stay light.
  }
  document.documentElement.dataset.theme = t
})()
