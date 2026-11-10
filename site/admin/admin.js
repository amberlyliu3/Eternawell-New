// EternaWell admin: bookings, website editing (via the in-page editor), availability and clinic details.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var settings = null;
  var view = 'upcoming';
  var bookings = [];
  var dirtyCount = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Blob)) { opts.body = JSON.stringify(opts.body); opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && path !== '/api/admin/login') { show('login'); throw new Error('Please sign in again.'); }
        if (!r.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function status(el, msg, isError) { el.textContent = msg; el.classList.toggle('is-error', !!isError); if (msg && !isError) setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 4000); }
  function fmtTime(min) { var h = Math.floor(min / 60), m = min % 60; return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function fmtDate(d, o) { var p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, o || { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(d, n) { return iso(new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5)); }

  // ---------- sign in ----------
  function show(which) {
    $('#login').hidden = which !== 'login';
    $('#setup').hidden = which !== 'setup';
    $('#app').hidden = which !== 'app';
    if (which === 'login') setTimeout(function () { $('#login-form input').focus(); }, 0);
  }

  api('/api/admin/me').then(start).catch(function (e) { show(e.status === 503 ? 'setup' : 'login'); });

  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var err = $('.error', f);
    err.textContent = '';
    f.querySelector('button').disabled = true;
    api('/api/admin/login', { method: 'POST', body: { password: f.password.value } })
      .then(function () { f.password.value = ''; start(); })
      .catch(function (e2) { err.textContent = e2.status === 503 ? 'The admin password has not been set up yet.' : e2.message; })
      .then(function () { f.querySelector('button').disabled = false; });
  });

  $('#logout').addEventListener('click', function () { api('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); }); });

  function start() {
    show('app');
    loadMessages();
    api('/api/admin/settings').then(function (s) { settings = s; fillTypeSelect(); renderAvailability(); fillClinic(); });
    loadBookings();
  }

  // ---------- tabs ----------
  $$('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (dirtyCount && b.dataset.tab !== 'website') { status($('#edit-status'), 'You have unsaved changes on this page. Save or discard them first.', true); return; }
      $$('.tabs button').forEach(function (x) { x.removeAttribute('aria-current'); });
      b.setAttribute('aria-current', 'page');
      $$('.panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
      if (b.dataset.tab === 'website' && !$('#editor').src) loadPage();
      if (b.dataset.tab === 'bookings') loadBookings();
      if (b.dataset.tab === 'messages') loadMessages();
    });
  });

  // ---------- bookings ----------
  $$('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      view = b.dataset.view;
      $$('.seg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      loadBookings();
    });
  });

  function loadBookings() {
    var st = $('#bookings-status');
    api('/api/admin/bookings?view=' + view).then(function (d) {
      bookings = d.bookings;
      renderBookings(d.today);
      status(st, '');
    }).catch(function (e) { status(st, e.message, true); });
  }

  function renderBookings(today) {
    var box = $('#bookings');
    if (!bookings.length) {
      box.innerHTML = '<p class="empty">' + ({ upcoming: 'No upcoming bookings.', past: 'No past bookings.', cancelled: 'No cancelled bookings.', all: 'No bookings yet.' })[view] + '</p>';
      return;
    }
    var html = '';
    var last = '';
    bookings.forEach(function (b) {
      if (b.date !== last) {
        if (last) html += '</ul>';
        html += '<h2 class="day">' + (b.date === today ? 'Today · ' : '') + fmtDate(b.date) + '</h2><ul class="blist">';
        last = b.date;
      }
      html += '<li class="bk ' + b.status + '" data-id="' + b.id + '">' +
        '<div class="when"><b>' + fmtTime(b.start) + '</b><span>' + b.minutes + ' min</span></div>' +
        '<div class="who"><b>' + esc(b.name) + '</b><span>' + esc(b.type_name) + ' · ' + (b.mode === 'telemedicine' ? 'Telemedicine' : 'In person') + (b.source === 'admin' ? ' · added by admin' : '') + '</span>' +
        '<span class="contact"><a href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">' + esc(b.phone) + '</a>' + (b.email ? ' · <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>' : '') + '</span>' +
        '<label class="note"><span class="visually-hidden">Note for ' + esc(b.name) + '</span><input value="' + esc(b.note) + '" placeholder="Add a note (no medical details)" data-act="note"></label></div>' +
        '<div class="state"><span class="chip ' + b.status + '">' + b.status[0].toUpperCase() + b.status.slice(1) + '</span></div>' +
        '<div class="acts">' +
        (b.status === 'confirmed' ? '<button type="button" class="btn ghost sm" data-act="completed">Mark visited</button><button type="button" class="btn ghost sm" data-act="cancelled">Cancel</button>' : '<button type="button" class="btn ghost sm" data-act="confirmed">Restore</button>') +
        '<button type="button" class="btn ghost sm danger" data-act="delete">Delete</button></div></li>';
    });
    box.innerHTML = html + '</ul>';
  }

  $('#bookings').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('li').dataset.id;
    var act = btn.dataset.act;
    var st = $('#bookings-status');
    if (act === 'delete' || act === 'cancelled') {
      if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = act === 'delete' ? 'Delete for good?' : 'Yes, cancel'; return; }
    }
    btn.disabled = true;
    var req = act === 'delete' ? api('/api/admin/bookings/' + id, { method: 'DELETE' }) : api('/api/admin/bookings/' + id, { method: 'PATCH', body: { status: act } });
    req.then(function () { status(st, act === 'delete' ? 'Booking deleted.' : 'Booking updated.'); loadBookings(); })
      .catch(function (e2) { status(st, e2.message, true); btn.disabled = false; });
  });

  $('#bookings').addEventListener('change', function (e) {
    if (e.target.dataset.act !== 'note') return;
    var id = e.target.closest('li').dataset.id;
    api('/api/admin/bookings/' + id, { method: 'PATCH', body: { note: e.target.value } })
      .then(function () { status($('#bookings-status'), 'Note saved.'); })
      .catch(function (e2) { status($('#bookings-status'), e2.message, true); });
  });

  function fillTypeSelect() {
    $('#add-form select[name="type"]').innerHTML = settings.visitTypes.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
  }

  $('#add-booking').addEventListener('click', function () { $('#add-form').hidden = false; $('#add-form input[name="date"]').focus(); });
  $('#add-cancel').addEventListener('click', function () { $('#add-form').hidden = true; });
  $('#add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var t = f.time.value.split(':').map(Number);
    api('/api/admin/bookings', { method: 'POST', body: { date: f.date.value, start: t[0] * 60 + t[1], type: f.type.value, mode: f.mode.value, name: f.name.value, phone: f.phone.value, email: f.email.value, note: f.note.value } })
      .then(function () { f.reset(); f.hidden = true; status($('#bookings-status'), 'Booking added.'); loadBookings(); })
      .catch(function (e2) { $('.error', f).textContent = e2.message; });
  });

  $('#export').addEventListener('click', function () {
    var rows = [['Date', 'Time', 'Minutes', 'Visit type', 'Visit', 'Name', 'Phone', 'Email', 'Status', 'Note', 'Booked']].concat(bookings.map(function (b) {
      return [b.date, fmtTime(b.start), b.minutes, b.type_name, b.mode, b.name, b.phone, b.email, b.status, b.note, new Date(b.created).toLocaleString()];
    }));
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'eternawell-bookings-' + view + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  // ---------- messages ----------
  var mview = 'all';
  $$('[data-mview]').forEach(function (b) {
    b.addEventListener('click', function () {
      mview = b.dataset.mview;
      $$('[data-mview]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      loadMessages();
    });
  });
  function loadMessages() {
    api('/api/admin/messages?view=' + mview).then(function (d) {
      var badge = $('#unread');
      badge.hidden = !d.unread;
      badge.textContent = d.unread;
      badge.setAttribute('aria-label', d.unread + ' unread');
      $('#messages').innerHTML = d.messages.length ? d.messages.map(function (m) {
        var contact = /@/.test(m.contact) ? '<a href="mailto:' + esc(m.contact) + '">' + esc(m.contact) + '</a>' : '<a href="tel:' + esc(m.contact.replace(/[^\d+]/g, '')) + '">' + esc(m.contact) + '</a>';
        return '<li class="m ' + m.status + '" data-id="' + m.id + '"><div class="m-head"><b>' + esc(m.name) + '</b>' + (m.status === 'new' ? '<span class="chip confirmed">New</span>' : '') +
          (m.lang.indexOf('zh') === 0 ? '<span class="chip">中文</span>' : '') + '<span class="m-when">' + new Date(m.created).toLocaleString() + '</span></div>' +
          '<p class="m-contact">' + contact + '</p><p class="m-body">' + esc(m.message) + '</p>' +
          '<div class="acts">' + (m.status === 'new' ? '<button type="button" class="btn ghost sm" data-mact="read">Mark as read</button>' : '<button type="button" class="btn ghost sm" data-mact="new">Mark as unread</button>') +
          '<button type="button" class="btn ghost sm danger" data-mact="delete">Delete</button></div></li>';
      }).join('') : '<li class="empty">No messages' + (mview === 'new' ? ' waiting.' : ' yet.') + '</li>';
    }).catch(function (e) { status($('#messages-status'), e.message, true); });
  }
  $('#messages').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mact]');
    if (!b) return;
    var id = b.closest('li').dataset.id;
    var act = b.dataset.mact;
    if (act === 'delete' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete for good?'; return; }
    b.disabled = true;
    (act === 'delete' ? api('/api/admin/messages/' + id, { method: 'DELETE' }) : api('/api/admin/messages/' + id, { method: 'PATCH', body: { status: act } }))
      .then(loadMessages)
      .catch(function (e2) { status($('#messages-status'), e2.message, true); b.disabled = false; });
  });

  // ---------- website editor ----------
  var frame = $('#editor');
  function loadPage() { dirty(0); frame.src = '/v8/' + $('#page').value + '?edit=1'; loadEdited(); }
  var lastPage = '';
  $('#page').addEventListener('focus', function () { lastPage = this.value; });
  $('#page').addEventListener('change', function () {
    if (dirtyCount) { this.value = lastPage; status($('#edit-status'), 'You have unsaved changes on this page. Save or discard them first.', true); return; }
    lastPage = this.value;
    loadPage();
  });
  function dirty(n) {
    dirtyCount = n;
    $('#save').disabled = !n;
    $('#discard').disabled = !n;
    $('#save').textContent = n ? 'Save changes (' + n + ')' : 'Save changes';
  }
  $('#save').addEventListener('click', function () { $('#save').disabled = true; frame.contentWindow.postMessage({ type: 'ew-save' }, location.origin); });
  $('#discard').addEventListener('click', function () { dirty(0); frame.contentWindow.location.reload(); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'ew-dirty') dirty(e.data.count);
    if (e.data.type === 'ew-saved') { dirty(0); status($('#edit-status'), 'Saved. The live website is updated.'); loadEdited(); }
    if (e.data.type === 'ew-error') { $('#save').disabled = false; status($('#edit-status'), e.data.message, true); }
  });
  window.addEventListener('beforeunload', function (e) { if (dirtyCount) { e.preventDefault(); e.returnValue = ''; } });

  function loadEdited() {
    api('/api/admin/content').then(function (d) {
      $('#edited-count').textContent = '(' + d.items.length + ')';
      $('#edited-list').innerHTML = d.items.length ? d.items.map(function (it) {
        var isImg = it.k.indexOf(':img-') !== -1;
        var text = isImg ? 'Photo' : it.v.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        var where = it.k.split(':')[0];
        return '<li><span class="where">' + esc(where === 'shared' ? 'Every page' : where) + '</span><span class="what">' + esc(text.length > 110 ? text.slice(0, 110) + '…' : text) + '</span>' +
          '<span class="when">' + new Date(it.updated).toLocaleDateString() + '</span><button type="button" class="btn ghost sm" data-key="' + esc(it.k) + '">Restore original</button></li>';
      }).join('') : '<li class="muted">Nothing edited yet.</li>';
    });
  }
  $('#edited-list').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-key]');
    if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Restore it?'; return; }
    var changes = {};
    changes[b.dataset.key] = null;
    api('/api/admin/content', { method: 'PUT', body: { changes: changes } }).then(function () {
      status($('#edit-status'), 'Original restored.');
      loadEdited();
      if (!dirtyCount) frame.contentWindow.location.reload();
    });
  });

  // ---------- availability ----------
  var calMonth = '';
  function renderAvailability() {
    ['slotStep', 'bufferMinutes', 'minNoticeHours', 'maxDaysAhead', 'retentionDays'].forEach(function (k) { $('#' + k).value = settings[k]; });
    $('#hours').innerHTML = DAYS.map(function (d, i) {
      var h = settings.hours[i];
      return '<div class="hour" data-day="' + i + '"><label class="check"><input type="checkbox"' + (h ? ' checked' : '') + '><span>' + d + '</span></label>' +
        '<label><span class="visually-hidden">' + d + ' opens</span><input type="time" value="' + (h ? h.start : '09:00') + '"' + (h ? '' : ' disabled') + '></label>' +
        '<span aria-hidden="true">to</span><label><span class="visually-hidden">' + d + ' closes</span><input type="time" value="' + (h ? h.end : '17:00') + '"' + (h ? '' : ' disabled') + '></label></div>';
    }).join('');
    renderTypes();
    if (!calMonth) calMonth = new Date().toISOString().slice(0, 7);
    renderBlockCal();
  }
  $('#hours').addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    $$('input[type="time"]', e.target.closest('.hour')).forEach(function (t) { t.disabled = !e.target.checked; });
  });

  function renderTypes() {
    $('#types').innerHTML = settings.visitTypes.map(function (t, i) {
      return '<div class="type" data-i="' + i + '" data-id="' + esc(t.id) + '">' +
        '<label class="field"><span>Name</span><input value="' + esc(t.name) + '" data-k="name"></label>' +
        '<label class="field"><span>Chinese name</span><input value="' + esc(t.name_zh || '') + '" data-k="name_zh" lang="zh-Hans"></label>' +
        '<label class="field"><span>Minutes</span><input type="number" min="5" max="480" value="' + t.minutes + '" data-k="minutes"></label>' +
        '<label class="check"><input type="checkbox"' + (t.active ? ' checked' : '') + ' data-k="active"><span>Bookable online</span></label>' +
        '<button type="button" class="btn ghost sm danger" data-remove="' + i + '">Remove</button></div>';
    }).join('');
  }
  $('#types').addEventListener('click', function (e) {
    var b = e.target.closest('[data-remove]');
    if (!b) return;
    readTypes();
    settings.visitTypes.splice(Number(b.dataset.remove), 1);
    renderTypes();
  });
  $('#add-type').addEventListener('click', function () {
    readTypes();
    settings.visitTypes.push({ id: 'type-' + Date.now().toString(36), name: 'New visit type', minutes: 30, active: true });
    renderTypes();
    $('#types .type:last-child input').select();
  });
  function readTypes() {
    settings.visitTypes = $$('#types .type').map(function (row) {
      return { id: row.dataset.id, name: $('[data-k="name"]', row).value, name_zh: $('[data-k="name_zh"]', row).value, minutes: Number($('[data-k="minutes"]', row).value), active: $('[data-k="active"]', row).checked };
    });
  }

  function renderBlockCal() {
    var p = calMonth.split('-').map(Number);
    var first = new Date(Date.UTC(p[0], p[1] - 1, 1));
    var days = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    var today = new Date().toISOString().slice(0, 10);
    var html = '<div class="cal-head"><button type="button" class="nav" data-d="-1" aria-label="Previous month">‹</button><b>' + fmtDate(calMonth + '-01', { month: 'long', year: 'numeric' }) + '</b><button type="button" class="nav" data-d="1" aria-label="Next month">›</button></div><div class="cal">';
    ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(function (d) { html += '<span class="dow" aria-hidden="true">' + d + '</span>'; });
    for (var i = 0; i < first.getUTCDay(); i++) html += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var ds = calMonth + '-' + String(d).padStart(2, '0');
      var blocked = settings.blockedDates.indexOf(ds) !== -1;
      var closed = !settings.hours[new Date(Date.parse(ds + 'T00:00:00Z')).getUTCDay()];
      html += '<button type="button" class="day' + (blocked ? ' blocked' : '') + (closed ? ' closed' : '') + (ds < today ? ' past' : '') + '" data-date="' + ds + '" aria-pressed="' + blocked + '" aria-label="' + fmtDate(ds) + (blocked ? ', blocked' : closed ? ', closed every week' : ', open') + '">' + d + '</button>';
    }
    html += '</div><p class="legend"><span class="k open"></span>Open <span class="k blocked"></span>Blocked <span class="k closed"></span>Closed every week</p>';
    $('#block-cal').innerHTML = html;
  }
  $('#block-cal').addEventListener('click', function (e) {
    var nav = e.target.closest('.nav');
    if (nav) {
      var p = calMonth.split('-').map(Number);
      calMonth = new Date(Date.UTC(p[0], p[1] - 1 + Number(nav.dataset.d), 1)).toISOString().slice(0, 7);
      renderBlockCal();
      return;
    }
    var day = e.target.closest('.day');
    if (!day) return;
    var ds = day.dataset.date;
    var i = settings.blockedDates.indexOf(ds);
    if (i === -1) settings.blockedDates.push(ds); else settings.blockedDates.splice(i, 1);
    renderBlockCal();
    $('#block-cal [data-date="' + ds + '"]').focus();
    status($('#avail-status'), 'Unsaved: press Save availability.', false);
  });
  function block(dates) {
    dates.forEach(function (d) { if (settings.blockedDates.indexOf(d) === -1) settings.blockedDates.push(d); });
    renderBlockCal();
    status($('#avail-status'), dates.length + ' days blocked. Press Save availability to keep them.');
  }
  $('#range-add').addEventListener('click', function () {
    var from = $('#range-from').value, to = $('#range-to').value || from;
    if (!from || to < from) { status($('#avail-status'), 'Choose a start and end date.', true); return; }
    var out = [];
    for (var d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
    block(out);
  });
  $('#repeat-add').addEventListener('click', function () {
    var dow = Number($('#repeat-day').value);
    var weeks = Number($('#repeat-weeks').value);
    var d = new Date().toISOString().slice(0, 10);
    while (new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay() !== dow) d = addDays(d, 1);
    var out = [];
    for (var w = 0; w < weeks; w++) out.push(addDays(d, w * 7));
    block(out);
  });

  $('#save-availability').addEventListener('click', function () {
    readTypes();
    settings.hours = $$('#hours .hour').map(function (row) {
      var on = $('input[type="checkbox"]', row).checked;
      var t = $$('input[type="time"]', row);
      return on ? { start: t[0].value, end: t[1].value } : null;
    });
    ['slotStep', 'bufferMinutes', 'minNoticeHours', 'maxDaysAhead', 'retentionDays'].forEach(function (k) { settings[k] = Number($('#' + k).value); });
    var today = new Date().toISOString().slice(0, 10);
    settings.blockedDates = settings.blockedDates.filter(function (d) { return d >= addDays(today, -1); });
    api('/api/admin/settings', { method: 'PUT', body: settings }).then(function (s) {
      settings = s;
      renderAvailability();
      fillTypeSelect();
      status($('#avail-status'), 'Availability saved. Online booking now uses these settings.');
    }).catch(function (e) { status($('#avail-status'), e.message, true); });
  });

  // ---------- clinic details ----------
  function fillClinic() {
    var f = $('#clinic-form');
    f.phone.value = settings.clinic.phone;
    f.address1.value = settings.clinic.address1;
    f.address2.value = settings.clinic.address2;
  }
  $('#clinic-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var st = $('.status', f);
    var next = Object.assign({}, settings, { clinic: { phone: f.phone.value, address1: f.address1.value, address2: f.address2.value } });
    api('/api/admin/settings', { method: 'PUT', body: next }).then(function (s) { settings = s; status(st, 'Saved. The website shows the new details within a few seconds.'); })
      .catch(function (e2) { status(st, e2.message, true); });
  });
})();
