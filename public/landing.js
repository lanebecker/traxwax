/* landing.js — decorative-image fallbacks for the marketing landing (#186 Phase 2).
   Was three inline onerror= attributes; moved here so public/_headers' script-src can
   drop 'unsafe-inline'. Same behaviour, attached via addEventListener, with a guard for
   an image that already errored before this deferred script ran. */
(function () {
  var apply = function (sel, fn) {
    var img = document.querySelector(sel);
    if (!img) return;
    var done = function () { fn(img); };
    img.addEventListener('error', done, { once: true });
    if (img.complete && img.naturalWidth === 0) done();   // already errored pre-script
  };
  apply('.tw-land-mosaic img', function (i) {
    i.removeAttribute('src');
    i.style.cssText = 'display:block;width:100%;aspect-ratio:.746;background:var(--skel)';
  });
  apply('.tw-land-shot img', function (i) {
    i.removeAttribute('src');
    i.style.cssText = 'display:block;width:100%;height:auto;min-height:340px;background:var(--skel);border:1.5px solid var(--line);box-shadow:8px 8px 0 rgba(0,0,0,.16)';
  });
  apply('.tw-slab-card', function (i) { i.style.display = 'none'; });
})();
