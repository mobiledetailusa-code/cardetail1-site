/**
 * Dedicated /reviews page: optional SMS invite form + full published list.
 */
(function (root) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function tokenFromLocation() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return String(params.get('t') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function setMsg(el, text, isErr) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
    el.classList.toggle('ok', !isErr && !!text);
    el.hidden = !text;
  }

  function starButtons(selected) {
    var row = $('rv-invite-stars');
    if (!row) return;
    row.querySelectorAll('[data-stars]').forEach(function (btn) {
      var n = Number(btn.getAttribute('data-stars'));
      btn.setAttribute('aria-pressed', n <= selected ? 'true' : 'false');
    });
  }

  function bootForm(token) {
    var panel = $('rv-invite');
    var loading = $('rv-invite-loading');
    var form = $('rv-invite-form');
    var thanks = $('rv-invite-thanks');
    var unavailable = $('rv-invite-unavailable');
    if (!panel) return;
    panel.hidden = false;
    if (loading) loading.hidden = false;
    if (form) form.hidden = true;
    if (thanks) thanks.hidden = true;
    if (unavailable) unavailable.hidden = true;

    fetch('/.netlify/functions/review-invite?t=' + encodeURIComponent(token))
      .then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); })
      .then(function (out) {
        if (loading) loading.hidden = true;
        var data = out.data || {};
        if (data.submitted) {
          if (thanks) thanks.hidden = false;
          return;
        }
        if (!out.res.ok || !data.ok || !data.available) {
          if (unavailable) {
            unavailable.hidden = false;
            var note = $('rv-invite-unavailable-note');
            if (note) note.textContent = data.message || 'This review link is no longer available. You can still look up the booking in My Garage.';
          }
          return;
        }
        var hello = $('rv-invite-hello');
        if (hello) hello.textContent = 'Thanks, ' + data.firstName + '. How was your detail?';
        var meta = $('rv-invite-meta');
        if (meta) {
          meta.textContent = [data.service, data.location, data.date].filter(Boolean).join(' · ');
        }
        if (form) form.hidden = false;
      })
      .catch(function () {
        if (loading) loading.hidden = true;
        if (unavailable) {
          unavailable.hidden = false;
          var note = $('rv-invite-unavailable-note');
          if (note) note.textContent = 'We could not open this review link. Try again, or look up the booking in My Garage.';
        }
      });

    var selected = 5;
    starButtons(selected);
    var starRow = $('rv-invite-stars');
    if (starRow && !starRow._bound) {
      starRow._bound = true;
      starRow.addEventListener('click', function (event) {
        var btn = event.target && event.target.closest && event.target.closest('[data-stars]');
        if (!btn) return;
        selected = Number(btn.getAttribute('data-stars')) || 5;
        starButtons(selected);
      });
    }

    var submit = $('rv-invite-submit');
    if (submit && !submit._bound) {
      submit._bound = true;
      submit.addEventListener('click', function () {
        var commentEl = $('rv-invite-comment');
        var msg = $('rv-invite-msg');
        submit.disabled = true;
        fetch('/.netlify/functions/submit-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: token,
            stars: selected,
            comment: commentEl ? commentEl.value : '',
          }),
        })
          .then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); })
          .then(function (out) {
            submit.disabled = false;
            if (out.data && out.data.ok) {
              if (form) form.hidden = true;
              if (thanks) {
                thanks.hidden = false;
                var thanksNote = $('rv-invite-thanks-note');
                if (thanksNote) {
                  thanksNote.textContent = out.data.published
                    ? 'Thanks — your review may appear on this page and on our homepage.'
                    : 'Thanks for your review.';
                }
              }
              return;
            }
            setMsg(msg, (out.data && out.data.message) || 'Review unavailable.', true);
          })
          .catch(function () {
            submit.disabled = false;
            setMsg(msg, 'Review unavailable.', true);
          });
      });
    }
  }

  function boot() {
    if (window.CD1CustomerReviews && typeof CD1CustomerReviews.mount === 'function') {
      CD1CustomerReviews.mount(document, { fetch: true });
    }
    var token = tokenFromLocation();
    if (token) bootForm(token);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
