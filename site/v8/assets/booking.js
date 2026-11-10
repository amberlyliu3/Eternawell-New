// Online booking: visit type → date → time → details. No account needed.
// Talks to the Worker API (/api/booking-info, /api/availability, /api/bookings).
(function () {
  var root = document.getElementById('booking');
  if (!root) return;
  var tel = root.dataset.tel || '';
  var phoneText = (document.querySelector('[data-set="phone"]') || {}).textContent || tel;
  var callLine = 'Please call or text <a href="tel:' + tel + '">' + esc(phoneText) + '</a>.';

  var state = { info: null, type: '', mode: 'in-person', month: '', date: '', start: null, dates: [] };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; });
    });
  }
  function fmtTime(min) { var h = Math.floor(min / 60), m = min % 60; return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function fmtDate(d, opts) { var p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts || { weekday: 'long', month: 'long', day: 'numeric' })); }
  function modeName(m) { return m === 'telemedicine' ? 'Telemedicine (secure video)' : 'In person, Bellevue office'; }
  function say(msg) { var l = root.querySelector('.bk-live'); if (l) l.textContent = msg; }

  var manage = new URLSearchParams(location.search).get('manage');
  if (manage) return showManage(manage);

  api('/api/booking-info').then(function (info) {
    state.info = info;
    if (!info.visitTypes.length) { root.innerHTML = '<div class="booking-empty"><p class="lede">Online booking is not available right now. ' + callLine + '</p></div>'; return; }
    state.type = info.visitTypes[0].id;
    state.month = info.today.slice(0, 7);
    render();
    loadMonth();
  }).catch(function () {
    root.innerHTML = '<div class="booking-empty"><p class="lede">Online booking is not available right now. ' + callLine + '</p></div>';
  });

  function render() {
    var info = state.info;
    root.innerHTML =
      '<form class="bk" novalidate>' +
      '<p class="bk-live visually-hidden" aria-live="polite"></p>' +
      '<div class="bk-col">' +
      '<fieldset class="bk-step"><legend><span class="bk-n">1</span>Visit type</legend><div class="bk-choices">' +
      info.visitTypes.map(function (t) {
        return '<label class="bk-choice"><input type="radio" name="type" value="' + esc(t.id) + '"' + (t.id === state.type ? ' checked' : '') + '><span><b>' + esc(t.name) + '</b><small>' + t.minutes + ' minutes</small></span></label>';
      }).join('') +
      '</div><div class="bk-choices bk-modes" role="group" aria-label="How you\'d like to meet">' +
      ['in-person', 'telemedicine'].map(function (m) {
        return '<label class="bk-choice"><input type="radio" name="mode" value="' + m + '"' + (m === state.mode ? ' checked' : '') + '><span><b>' + (m === 'telemedicine' ? 'Telemedicine' : 'In person') + '</b><small>' + (m === 'telemedicine' ? 'Secure video from home' : 'Our Bellevue office') + '</small></span></label>';
      }).join('') +
      '</div></fieldset>' +
      '<fieldset class="bk-step"><legend><span class="bk-n">2</span>Date</legend><div class="bk-cal"></div></fieldset>' +
      '</div><div class="bk-col">' +
      '<fieldset class="bk-step"><legend><span class="bk-n">3</span>Time</legend><div class="bk-times"><p class="bk-hint">Choose a date to see open times.</p></div></fieldset>' +
      '<fieldset class="bk-step bk-details"><legend><span class="bk-n">4</span>Your details</legend>' +
      '<label class="bk-field"><span>Full name</span><input name="name" autocomplete="name" required maxlength="100"></label>' +
      '<label class="bk-field"><span>Mobile phone</span><input name="phone" type="tel" autocomplete="tel" required maxlength="30"></label>' +
      '<label class="bk-field"><span>Email</span><input name="email" type="email" autocomplete="email" required maxlength="120"></label>' +
      '<label class="bk-hp" aria-hidden="true">Company <input name="website" tabindex="-1" autocomplete="off"></label>' +
      '<label class="bk-consent"><input type="checkbox" name="consent" required><span>I consent to EternaWell Medicine collecting the information on this form, including the visit type I choose, to schedule my visit and contact me about it, as described in the <a href="' + location.pathname.replace(/book\/?$/, '') + 'legal/#health-data">Consumer Health Data Privacy Policy</a>.</span></label>' +
      '<p class="bk-summary" aria-live="polite"></p>' +
      '<p class="bk-error" role="alert"></p>' +
      '<button type="submit" class="btn btn-primary bk-submit">Book appointment</button>' +
      '</fieldset></div></form>';

    var form = root.querySelector('form');
    form.addEventListener('change', function (e) {
      if (e.target.name === 'type') { state.type = e.target.value; state.date = ''; state.start = null; loadMonth(); renderTimes(); }
      if (e.target.name === 'mode') { state.mode = e.target.value; summary(); }
    });
    form.addEventListener('submit', submit);
    renderCal();
  }

  function loadMonth() {
    var cal = root.querySelector('.bk-cal');
    if (cal) cal.setAttribute('aria-busy', 'true');
    var want = state.type + state.month;
    api('/api/availability?type=' + encodeURIComponent(state.type) + '&month=' + state.month).then(function (d) {
      if (want !== state.type + state.month) return;
      state.dates = d.dates;
      renderCal();
      say(d.dates.length ? d.dates.length + ' days with open times in ' + fmtDate(state.month + '-01', { month: 'long', year: 'numeric' }) + '.' : 'No open times in ' + fmtDate(state.month + '-01', { month: 'long' }) + '.');
    }).catch(function (e) { showError(e.message); });
  }

  function shiftMonth(delta) {
    var p = state.month.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + delta, 1));
    state.month = d.toISOString().slice(0, 7);
    state.dates = [];
    renderCal();
    loadMonth();
  }

  function renderCal() {
    var cal = root.querySelector('.bk-cal');
    if (!cal) return;
    var p = state.month.split('-').map(Number);
    var first = new Date(Date.UTC(p[0], p[1] - 1, 1));
    var days = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    var minMonth = state.info.today.slice(0, 7);
    var maxDate = new Date(Date.parse(state.info.today + 'T00:00:00Z') + state.info.maxDaysAhead * 864e5).toISOString().slice(0, 7);
    var html = '<div class="bk-cal-head"><button type="button" class="bk-nav" data-d="-1" aria-label="Previous month"' + (state.month <= minMonth ? ' disabled' : '') + '>‹</button>' +
      '<b>' + fmtDate(state.month + '-01', { month: 'long', year: 'numeric' }) + '</b>' +
      '<button type="button" class="bk-nav" data-d="1" aria-label="Next month"' + (state.month >= maxDate ? ' disabled' : '') + '>›</button></div>' +
      '<div class="bk-grid" role="grid"><span aria-hidden="true">Su</span><span aria-hidden="true">Mo</span><span aria-hidden="true">Tu</span><span aria-hidden="true">We</span><span aria-hidden="true">Th</span><span aria-hidden="true">Fr</span><span aria-hidden="true">Sa</span>';
    for (var i = 0; i < first.getUTCDay(); i++) html += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var ds = state.month + '-' + String(d).padStart(2, '0');
      var open = state.dates.indexOf(ds) !== -1;
      html += '<button type="button" class="bk-day' + (ds === state.date ? ' on' : '') + '" data-date="' + ds + '"' + (open ? '' : ' disabled') +
        ' aria-pressed="' + (ds === state.date) + '" aria-label="' + fmtDate(ds) + (open ? '' : ', not available') + '">' + d + '</button>';
    }
    html += '</div><p class="bk-legend"><span class="bk-key"></span> Available</p>';
    cal.innerHTML = html;
    cal.removeAttribute('aria-busy');
    cal.querySelectorAll('.bk-nav').forEach(function (b) { b.addEventListener('click', function () { shiftMonth(Number(b.dataset.d)); }); });
    cal.querySelectorAll('.bk-day:not([disabled])').forEach(function (b) {
      b.addEventListener('click', function () { state.date = b.dataset.date; state.start = null; renderCal(); renderTimes(); root.querySelector('.bk-day.on').focus(); });
    });
  }

  function renderTimes() {
    var box = root.querySelector('.bk-times');
    summary();
    if (!state.date) { box.innerHTML = '<p class="bk-hint">Choose a date to see open times.</p>'; return; }
    box.innerHTML = '<p class="bk-hint">Loading times…</p>';
    var want = state.type + state.date;
    api('/api/availability?type=' + encodeURIComponent(state.type) + '&date=' + state.date).then(function (d) {
      if (want !== state.type + state.date) return;
      if (!d.times.length) { box.innerHTML = '<p class="bk-hint">No open times left on this day. Please choose another date.</p>'; return; }
      box.innerHTML = '<p class="bk-hint">' + fmtDate(state.date) + ' · Pacific Time</p><div class="bk-slots">' + d.times.map(function (t) {
        return '<button type="button" class="bk-slot" data-t="' + t + '" aria-pressed="false">' + fmtTime(t) + '</button>';
      }).join('') + '</div>';
      say(d.times.length + ' open times on ' + fmtDate(state.date) + '.');
      box.querySelectorAll('.bk-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          state.start = Number(b.dataset.t);
          box.querySelectorAll('.bk-slot').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
          summary();
        });
      });
    }).catch(function (e) { box.innerHTML = '<p class="bk-hint">' + esc(e.message) + '</p>'; });
  }

  function currentType() { return state.info.visitTypes.filter(function (t) { return t.id === state.type; })[0]; }

  function summary() {
    var el = root.querySelector('.bk-summary');
    if (!el) return;
    el.textContent = state.date && state.start !== null
      ? currentType().name + ' · ' + fmtDate(state.date) + ' at ' + fmtTime(state.start) + ' · ' + (state.mode === 'telemedicine' ? 'Telemedicine' : 'In person')
      : '';
  }

  function showError(msg) {
    var el = root.querySelector('.bk-error');
    if (el) el.innerHTML = esc(msg) + ' ' + (/call or text/i.test(msg) ? '' : 'If it keeps happening, ' + callLine.charAt(0).toLowerCase() + callLine.slice(1));
  }

  function submit(e) {
    e.preventDefault();
    var f = e.target;
    var err = root.querySelector('.bk-error');
    err.textContent = '';
    if (!state.date || state.start === null) return showError('Please choose a date and time.');
    if (!f.name.value.trim()) { f.name.focus(); return showError('Please enter your name.'); }
    if ((f.phone.value.match(/\d/g) || []).length < 7) { f.phone.focus(); return showError('Please enter a phone number we can reach you at.'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) { f.email.focus(); return showError('Please check your email address.'); }
    if (!f.consent.checked) { f.consent.focus(); return showError('Please confirm the consent box to book.'); }
    var btn = f.querySelector('.bk-submit');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    api('/api/bookings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: state.type, mode: state.mode, date: state.date, start: state.start, name: f.name.value, phone: f.phone.value, email: f.email.value, website: f.website.value, consent: f.consent.checked }),
    }).then(function (d) {
      if (!d.booking) { showError('Something went wrong.'); return; }
      var link = location.origin + location.pathname + '?manage=' + d.token;
      root.innerHTML = '<div class="bk-done" tabindex="-1"><span class="eyebrow">You\'re booked</span>' +
        '<h3>' + esc(d.booking.type_name) + '</h3>' +
        '<p class="lede">' + fmtDate(d.booking.date) + ' at ' + fmtTime(d.booking.start) + ' (Pacific Time) · ' + modeName(d.booking.mode) + '</p>' +
        '<p>Thank you, ' + esc(d.booking.name) + '. We\'ll contact you before your visit to confirm details' + (d.booking.mode === 'telemedicine' ? ' and send your video link' : '') + '.</p>' +
        '<p class="bk-manage">Need to cancel? Save this private link: <a href="' + link + '">' + esc(link) + '</a></p></div>';
      root.querySelector('.bk-done').focus();
    }).catch(function (e2) {
      showError(e2.message);
      btn.disabled = false;
      btn.textContent = 'Book appointment';
      if (/taken/.test(e2.message)) { state.start = null; renderTimes(); loadMonth(); }
    });
  }

  function showManage(token) {
    root.innerHTML = '<div class="bk-done"><p class="bk-hint">Loading your booking…</p></div>';
    api('/api/booking?t=' + encodeURIComponent(token)).then(function (d) {
      var b = d.booking;
      var box = root.querySelector('.bk-done');
      box.innerHTML = '<span class="eyebrow">Your booking</span><h3>' + esc(b.type_name) + '</h3>' +
        '<p class="lede">' + fmtDate(b.date) + ' at ' + fmtTime(b.start) + ' (Pacific Time) · ' + modeName(b.mode) + '</p>' +
        (b.status === 'cancelled' ? '<p><b>This booking is cancelled.</b></p><div class="actions"><a class="btn btn-primary" href="' + location.pathname + '">Book a new time</a></div>'
          : b.status === 'completed' ? '<p>This visit has already taken place.</p>'
          : '<p>Can\'t make it? Cancel below and book a new time whenever you\'re ready.</p><div class="actions"><button type="button" class="btn btn-primary bk-cancel">Cancel this booking</button></div><p class="bk-error" role="alert"></p>');
      var c = box.querySelector('.bk-cancel');
      if (c) c.addEventListener('click', function () {
        if (c.dataset.sure !== '1') { c.dataset.sure = '1'; c.textContent = 'Yes, cancel it'; return; }
        c.disabled = true;
        api('/api/booking/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: token }) })
          .then(function () { showManage(token); })
          .catch(function (e) { box.querySelector('.bk-error').textContent = e.message; c.disabled = false; });
      });
    }).catch(function () {
      root.querySelector('.bk-done').innerHTML = '<p class="lede">We couldn\'t find that booking. ' + callLine + '</p>';
    });
  }
})();
