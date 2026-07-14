/**
 * Specialty gallery helpers: single-video playback + BA range sync.
 */
(function () {
  'use strict';

  function pauseSiblingVideos(active) {
    document.querySelectorAll('.sp-video-frame video').forEach(function (v) {
      if (v !== active) {
        try { v.pause(); } catch (e) {}
      }
    });
  }

  function bindVideos() {
    document.querySelectorAll('.sp-video-frame video').forEach(function (video) {
      video.addEventListener('play', function () {
        pauseSiblingVideos(video);
      });
    });
  }

  function bindBeforeAfter() {
    document.querySelectorAll('.sp-ba-card .ba-compare').forEach(function (root) {
      var range = root.querySelector('input[type="range"]');
      if (!range || range.dataset.bound === '1') return;
      range.dataset.bound = '1';
      function sync() {
        root.style.setProperty('--ba-pos', String(range.value) + '%');
      }
      range.addEventListener('input', sync);
      range.addEventListener('change', sync);
      sync();
    });
  }

  function init() {
    bindVideos();
    bindBeforeAfter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.CD1SpecialtyGallery = { init: init, pauseSiblingVideos: pauseSiblingVideos };
})();
