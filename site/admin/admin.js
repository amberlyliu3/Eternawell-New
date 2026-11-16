// EternaWell admin: bookings, messages, website editing (via the in-page editor), availability and clinic details.
// Interface text is in English or Chinese (i18n.js); the toggle in the top bar switches it.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var I = window.EW_I18N;
  var T = I.t;
  var PAGES = ['home', 'services', 'about', 'membership', 'products', 'faq', 'book', 'legal'];
  var settings = null;
  var lastToday = '';
  var view = 'upcoming';
  var bookings = [];
  var dirtyCount = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Blob)) { opts.body = JSON.stringify(opts.body); opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && path !== '/api/admin/login') { show('login'); throw new Error(T('err.signin')); }
        if (!r.ok) { var e = new Error(I.srv(d.error) || T('err.generic')); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function status(el, msg, isError) { el.textContent = msg; el.classList.toggle('is-error', !!isError); if (msg && !isError) setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 4000); }
  function fmtTime(min) {
    var h = Math.floor(min / 60), m = String(min % 60).padStart(2, '0');
    if (I.lang === 'zh') return (h < 12 ? '上午 ' : '下午 ') + ((h + 11) % 12 + 1) + ':' + m;
    return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function fmtDate(d, o) { var p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(T('locale'), Object.assign({ timeZone: 'UTC' }, o || { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })); }
  function fmtStamp(ms) { return new Date(ms).toLocaleString(T('locale')); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(d, n) { return iso(new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5)); }

  // ---------- interface language ----------
  function applyLang() {
    document.documentElement.lang = I.lang === 'zh' ? 'zh-Hans' : 'en';
    document.title = I.lang === 'zh' ? '管理后台 · EternaWell Medicine' : 'Admin · EternaWell Medicine';
    I.apply();
    fillPages();
    dirty(dirtyCount);
    if (settings) { fillTypeSelect(); renderAvailability(); }
    if (!$('#app').hidden) { renderBookings(lastToday); loadMessages(); loadEdited(); }
  }
  $$('.lang-toggle').forEach(function (b) {
    b.addEventListener('click', function () { I.set(I.lang === 'zh' ? 'en' : 'zh'); applyLang(); });
  });

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
      .catch(function (e2) { err.textContent = e2.status === 503 ? T('err.noPassword') : e2.message; })
      .then(function () { f.querySelector('button').disabled = false; });
  });

  $('#logout').addEventListener('click', function () { api('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); }); });

  function start() {
    show('app');
    loadMessages();
    api('/api/admin/settings').then(function (s) { settings = s; fillTypeSelect(); renderAvailability(); fillClinic(); if (lastToday) renderBookings(lastToday); });
    loadBookings();
  }

  // ---------- tabs ----------
  $$('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (dirtyCount && b.dataset.tab !== 'website') { status($('#edit-status'), T('web.unsaved'), true); return; }
      $$('.tabs button').forEach(function (x) { x.removeAttribute('aria-current'); });
      b.setAttribute('aria-current', 'page');
      $$('.panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
      if (b.dataset.tab === 'website' && !$('#editor').src) loadPage();
      if (b.dataset.tab === 'bookings') loadBookings();
      if (b.dataset.tab === 'messages') loadMessages();
      if (b.dataset.tab === 'availability') loadSchedule();
    });
  });

  // ---------- bookings ----------
  $$('.seg button[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      view = b.dataset.view;
      $$('.seg button[data-view]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      loadBookings();
    });
  });

  function loadBookings() {
    var st = $('#bookings-status');
    api('/api/admin/bookings?view=' + view).then(function (d) {
      bookings = d.bookings;
      lastToday = d.today;
      renderBookings(d.today);
      status(st, '');
    }).catch(function (e) { status(st, e.message, true); });
  }

  function renderBookings(today) {
    var box = $('#bookings');
    if (!bookings.length) {
      box.innerHTML = '<p class="empty">' + T('bk.empty.' + view) + '</p>';
      return;
    }
    var html = '';
    var last = '';
    bookings.forEach(function (b) {
      if (b.date !== last) {
        if (last) html += '</ul>';
        html += '<h2 class="day">' + (b.date === today ? T('bk.today') : '') + fmtDate(b.date) + '</h2><ul class="blist">';
        last = b.date;
      }
      html += '<li class="bk ' + b.status + '" data-id="' + b.id + '">' +
        '<div class="when"><b>' + fmtTime(b.start) + '</b><span>' + T('bk.min', b.minutes) + '</span></div>' +
        '<div class="who"><b>' + esc(b.name) + '</b><span>' + esc(typeName(b.type, b.type_name)) + ' · ' + T(b.mode === 'telemedicine' ? 'mode.tele' : 'mode.in') + (b.source === 'admin' ? T('bk.byAdmin') : '') + '</span>' +
        '<span class="contact"><a href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">' + esc(b.phone) + '</a>' + (b.email ? ' · <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>' : '') + '</span>' +
        '<label class="note"><span class="visually-hidden">' + esc(T('bk.noteFor', b.name)) + '</span><input value="' + esc(b.note) + '" placeholder="' + esc(T('bk.notePh')) + '" data-act="note"></label></div>' +
        '<div class="state"><span class="chip ' + b.status + '">' + T('st.' + b.status) + '</span></div>' +
        '<div class="acts">' +
        (b.status === 'confirmed' ? '<button type="button" class="btn ghost sm" data-act="completed">' + T('act.visited') + '</button><button type="button" class="btn ghost sm" data-act="cancelled">' + T('act.cancel') + '</button>' : '<button type="button" class="btn ghost sm" data-act="confirmed">' + T('act.restore') + '</button>') +
        '<button type="button" class="btn ghost sm danger" data-act="delete">' + T('act.delete') + '</button></div></li>';
    });
    box.innerHTML = html + '</ul>';
  }

  // Visit type name in the admin's language (the booking keeps the English name it was made with)
  function typeName(id, fallback) {
    var t = settings && settings.visitTypes.filter(function (v) { return v.id === id; })[0];
    if (!t) return fallback;
    return (I.lang === 'zh' && t.name_zh) || t.name;
  }

  $('#bookings').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('li').dataset.id;
    var act = btn.dataset.act;
    var st = $('#bookings-status');
    if (act === 'delete' || act === 'cancelled') {
      if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = T(act === 'delete' ? 'sure.delete' : 'sure.cancel'); return; }
    }
    btn.disabled = true;
    var req = act === 'delete' ? api('/api/admin/bookings/' + id, { method: 'DELETE' }) : api('/api/admin/bookings/' + id, { method: 'PATCH', body: { status: act } });
    req.then(function () { status(st, T(act === 'delete' ? 'bk.deleted' : 'bk.updated')); loadBookings(); })
      .catch(function (e2) { status(st, e2.message, true); btn.disabled = false; });
  });

  $('#bookings').addEventListener('change', function (e) {
    if (e.target.dataset.act !== 'note') return;
    var id = e.target.closest('li').dataset.id;
    api('/api/admin/bookings/' + id, { method: 'PATCH', body: { note: e.target.value } })
      .then(function () { status($('#bookings-status'), T('bk.noteSaved')); })
      .catch(function (e2) { status($('#bookings-status'), e2.message, true); });
  });

  function fillTypeSelect() {
    var sel = $('#add-form select[name="type"]');
    var cur = sel.value;
    sel.innerHTML = settings.visitTypes.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc((I.lang === 'zh' && t.name_zh) || t.name) + '</option>'; }).join('');
    if (cur) sel.value = cur;
  }

  $('#add-booking').addEventListener('click', function () { $('#add-form').hidden = false; $('#add-form input[name="date"]').focus(); });
  $('#add-cancel').addEventListener('click', function () { $('#add-form').hidden = true; });
  $('#add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var t = f.time.value.split(':').map(Number);
    api('/api/admin/bookings', { method: 'POST', body: { date: f.date.value, start: t[0] * 60 + t[1], type: f.type.value, mode: f.mode.value, name: f.name.value, phone: f.phone.value, email: f.email.value, note: f.note.value } })
      .then(function () { f.reset(); f.hidden = true; status($('#bookings-status'), T('bk.added')); loadBookings(); })
      .catch(function (e2) { $('.error', f).textContent = e2.message; });
  });

  $('#export').addEventListener('click', function () {
    var rows = [T('csv')].concat(bookings.map(function (b) {
      return [b.date, fmtTime(b.start), b.minutes, typeName(b.type, b.type_name), T(b.mode === 'telemedicine' ? 'mode.tele' : 'mode.in'), b.name, b.phone, b.email, T('st.' + b.status), b.note, fmtStamp(b.created)];
    }));
    var csv = '\ufeff' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
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
      badge.setAttribute('aria-label', T('msg.unread', d.unread));
      $('#messages').innerHTML = d.messages.length ? d.messages.map(function (m) {
        var contact = /@/.test(m.contact) ? '<a href="mailto:' + esc(m.contact) + '">' + esc(m.contact) + '</a>' : '<a href="tel:' + esc(m.contact.replace(/[^\d+]/g, '')) + '">' + esc(m.contact) + '</a>';
        return '<li class="m ' + m.status + '" data-id="' + m.id + '"><div class="m-head"><b>' + esc(m.name) + '</b>' + (m.status === 'new' ? '<span class="chip confirmed">' + T('msg.new') + '</span>' : '') +
          (m.lang.indexOf('zh') === 0 ? '<span class="chip">中文</span>' : '') + '<span class="m-when">' + fmtStamp(m.created) + '</span></div>' +
          '<p class="m-contact">' + contact + '</p><p class="m-body">' + esc(m.message) + '</p>' +
          '<div class="acts">' + (m.status === 'new' ? '<button type="button" class="btn ghost sm" data-mact="read">' + T('msg.markRead') + '</button>' : '<button type="button" class="btn ghost sm" data-mact="new">' + T('msg.markUnread') + '</button>') +
          '<button type="button" class="btn ghost sm danger" data-mact="delete">' + T('act.delete') + '</button></div></li>';
      }).join('') : '<li class="empty">' + T(mview === 'new' ? 'msg.emptyNew' : 'msg.empty') + '</li>';
    }).catch(function (e) { status($('#messages-status'), e.message, true); });
  }
  $('#messages').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mact]');
    if (!b) return;
    var id = b.closest('li').dataset.id;
    var act = b.dataset.mact;
    if (act === 'delete' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = T('sure.delete'); return; }
    b.disabled = true;
    (act === 'delete' ? api('/api/admin/messages/' + id, { method: 'DELETE' }) : api('/api/admin/messages/' + id, { method: 'PATCH', body: { status: act } }))
      .then(loadMessages)
      .catch(function (e2) { status($('#messages-status'), e2.message, true); b.disabled = false; });
  });

  // ---------- website editor ----------
  var frame = $('#editor');
  var siteLang = 'en';
  function pagePath(p) { return '/v8/' + (siteLang === 'zh' ? 'zh/' : '') + (p === 'home' ? '' : p + '/'); }
  function loadPage() { dirty(0); frame.src = pagePath($('#page').value) + '?edit=1'; loadEdited(); }
  function fillPages() {
    var sel = $('#page');
    var cur = sel.value || 'home';
    sel.innerHTML = PAGES.map(function (p) { return '<option value="' + p + '">' + esc(T('page.' + p)) + '</option>'; }).join('');
    sel.value = cur;
  }
  var lastPage = 'home';
  $('#page').addEventListener('focus', function () { lastPage = this.value; });
  $('#page').addEventListener('change', function () {
    if (dirtyCount) { this.value = lastPage; status($('#edit-status'), T('web.unsaved'), true); return; }
    lastPage = this.value;
    loadPage();
  });
  $$('#site-lang button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.site === siteLang) return;
      if (dirtyCount) { status($('#edit-status'), T('web.unsaved'), true); return; }
      siteLang = b.dataset.site;
      $$('#site-lang button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      loadPage();
    });
  });
  function dirty(n) {
    dirtyCount = n;
    $('#save').disabled = !n;
    $('#discard').disabled = !n;
    $('#save').textContent = n ? T('web.saveN', n) : T('web.save');
  }
  $('#save').addEventListener('click', function () { $('#save').disabled = true; frame.contentWindow.postMessage({ type: 'ew-save' }, location.origin); });
  $('#discard').addEventListener('click', function () { dirty(0); frame.contentWindow.location.reload(); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'ew-dirty') dirty(e.data.count);
    if (e.data.type === 'ew-saved') { dirty(0); status($('#edit-status'), T('web.saved')); loadEdited(); }
    if (e.data.type === 'ew-error') { $('#save').disabled = false; status($('#edit-status'), I.srv(e.data.message), true); }
  });
  window.addEventListener('beforeunload', function (e) { if (dirtyCount) { e.preventDefault(); e.returnValue = ''; } });

  function loadEdited() {
    api('/api/admin/content').then(function (d) {
      $('#edited-count').textContent = '(' + d.items.length + ')';
      $('#edited-list').innerHTML = d.items.length ? d.items.map(function (it) {
        var isImg = it.k.indexOf(':img-') !== -1;
        var text = isImg ? T('web.photo') : it.v.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        return '<li><span class="where">' + esc(whereLabel(it.k.split(':')[0])) + '</span><span class="what">' + esc(text.length > 110 ? text.slice(0, 110) + '…' : text) + '</span>' +
          '<span class="when">' + new Date(it.updated).toLocaleDateString(T('locale')) + '</span><button type="button" class="btn ghost sm" data-key="' + esc(it.k) + '">' + T('web.restore') + '</button></li>';
      }).join('') : '<li class="muted">' + T('web.nothing') + '</li>';
    });
  }
  // "zh-about" → "Meet the Doctor (Chinese)", "shared" → "Every page (English)"
  function whereLabel(scope) {
    var zh = scope.indexOf('zh-') === 0;
    var page = zh ? scope.slice(3) : scope;
    var name = page === 'shared' ? T('web.everyPage') : T('page.' + page);
    return name + (I.lang === 'zh' ? '（' : ' (') + T(zh ? 'lang.zh' : 'lang.en') + (I.lang === 'zh' ? '）' : ')');
  }
  $('#edited-list').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-key]');
    if (!b) return;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = T('web.restoreSure'); return; }
    var changes = {};
    changes[b.dataset.key] = null;
    api('/api/admin/content', { method: 'PUT', body: { changes: changes } }).then(function () {
      status($('#edit-status'), T('web.restored'));
      loadEdited();
      if (!dirtyCount) frame.contentWindow.location.reload();
    });
  });

  // ---------- availability ----------
  function renderAvailability() {
    ['slotStep', 'bufferMinutes', 'minNoticeHours', 'maxDaysAhead', 'retentionDays'].forEach(function (k) { $('#' + k).value = settings[k]; });
    $('#hours').innerHTML = T('days').map(function (d, i) {
      var h = settings.hours[i];
      return '<div class="hour" data-day="' + i + '"><label class="check"><input type="checkbox"' + (h ? ' checked' : '') + '><span>' + d + '</span></label>' +
        '<label><span class="visually-hidden">' + T('av.opens', d) + '</span><input type="time" value="' + (h ? h.start : '09:00') + '"' + (h ? '' : ' disabled') + '></label>' +
        '<span aria-hidden="true">' + T('av.toWord') + '</span><label><span class="visually-hidden">' + T('av.closes', d) + '</span><input type="time" value="' + (h ? h.end : '17:00') + '"' + (h ? '' : ' disabled') + '></label></div>';
    }).join('');
    renderTypes();
    renderSchedule();
    renderGoogle();
  }

  // ---------- Google Calendar ----------
  function renderGoogle() {
    var g = settings.google;
    $('#g-cal').value = g.calendarId;
    $('#g-add').checked = g.addEvents;
    $('#g-busy').checked = g.blockBusy;
    $('#g-detail').value = g.detail;
    api('/api/admin/google').then(function (d) {
      var st = $('#g-status');
      $('#g-share').hidden = !d.keyAdded;
      $('#g-email').textContent = d.serviceEmail;
      if (!d.keyAdded) { st.textContent = T('g.noKey'); st.className = 'g-status bad'; return; }
      if (!g.calendarId) { st.textContent = T('g.noCal'); st.className = 'g-status'; return; }
      if (d.status && !d.status.ok) { st.textContent = T('g.problemAt', I.srv(d.status.message), fmtStamp(d.status.at)); st.className = 'g-status bad'; return; }
      st.textContent = T('g.connected') + (d.status ? ' · ' + I.srv(d.status.message) : '.'); st.className = 'g-status good';
    });
  }
  function readGoogle() {
    settings.google = { calendarId: $('#g-cal').value.trim(), addEvents: $('#g-add').checked, blockBusy: $('#g-busy').checked, detail: $('#g-detail').value };
  }
  $('#g-copy').addEventListener('click', function () {
    navigator.clipboard.writeText($('#g-email').textContent).then(function () { status($('#g-result'), T('g.copied')); });
  });
  $('#g-test').addEventListener('click', function () {
    var b = this;
    b.disabled = true;
    status($('#g-result'), T('g.testing'));
    api('/api/admin/google/test', { method: 'POST', body: { calendarId: $('#g-cal').value.trim() } })
      .then(function (d) { var el = $('#g-result'); el.textContent = I.srv(d.message); el.classList.toggle('is-error', !d.ok); })
      .catch(function (e) { status($('#g-result'), e.message, true); })
      .then(function () { b.disabled = false; });
  });
  $('#g-sync').addEventListener('click', function () {
    var b = this;
    if (dirtyAvailability()) { status($('#g-result'), T('g.saveFirst'), true); return; }
    b.disabled = true;
    status($('#g-result'), T('g.adding'));
    api('/api/admin/google/sync', { method: 'POST' })
      .then(function (d) {
        var ok = !d.status || d.status.ok;
        var el = $('#g-result');
        el.textContent = ok ? T('g.synced', d.count) : T('g.problem', I.srv(d.status.message));
        el.classList.toggle('is-error', !ok);
        renderGoogle();
      })
      .catch(function (e) { status($('#g-result'), e.message, true); })
      .then(function () { b.disabled = false; });
  });
  function dirtyAvailability() {
    var g = settings.google;
    return $('#g-cal').value.trim() !== g.calendarId || $('#g-add').checked !== g.addEvents || $('#g-busy').checked !== g.blockBusy || $('#g-detail').value !== g.detail;
  }
  $('#hours').addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    $$('input[type="time"]', e.target.closest('.hour')).forEach(function (t) { t.disabled = !e.target.checked; });
  });

  function renderTypes() {
    $('#types').innerHTML = settings.visitTypes.map(function (t, i) {
      return '<div class="type" data-i="' + i + '" data-id="' + esc(t.id) + '">' +
        '<label class="field"><span>' + T('ty.name') + '</span><input value="' + esc(t.name) + '" data-k="name"></label>' +
        '<label class="field"><span>' + T('ty.nameZh') + '</span><input value="' + esc(t.name_zh || '') + '" data-k="name_zh" lang="zh-Hans"></label>' +
        '<label class="field"><span>' + T('ty.minutes') + '</span><input type="number" min="5" max="480" value="' + t.minutes + '" data-k="minutes"></label>' +
        '<label class="check"><input type="checkbox"' + (t.active ? ' checked' : '') + ' data-k="active"><span>' + T('ty.active') + '</span></label>' +
        '<button type="button" class="btn ghost sm danger" data-remove="' + i + '">' + T('ty.remove') + '</button></div>';
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
    settings.visitTypes.push({ id: 'type-' + Date.now().toString(36), name: T('ty.new'), name_zh: '', minutes: 30, active: true });
    renderTypes();
    $('#types .type:last-child input').select();
  });
  function readTypes() {
    settings.visitTypes = $$('#types .type').map(function (row) {
      return { id: row.dataset.id, name: $('[data-k="name"]', row).value, name_zh: $('[data-k="name_zh"]', row).value, minutes: Number($('[data-k="minutes"]', row).value), active: $('[data-k="active"]', row).checked };
    });
  }

  // ---------- schedule (week view, like Google Calendar) ----------
  var H = 52; // pixels per hour
  var sc = { start: '', data: null };
  function weekStart(d) { var w = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay(); return addDays(d, -w); }
  function hm2(v) { var p = v.split(':').map(Number); return p[0] * 60 + p[1]; }
  function mm2hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function loadSchedule() {
    if (!sc.start) sc.start = weekStart(lastToday || new Date().toISOString().slice(0, 10));
    var from = sc.start, to = addDays(sc.start, 6);
    api('/api/admin/schedule?from=' + from + '&to=' + to).then(function (d) {
      if (from !== sc.start) return;
      sc.data = d;
      if (!lastToday) lastToday = d.today;
      settings.blockedDates = d.blockedDates;
      settings.blockedTimes = d.blockedTimes;
      renderSchedule();
    }).catch(function (e) { status($('#avail-status'), e.message, true); });
  }
  function renderSchedule() {
    var d = sc.data;
    if (!d) return;
    var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(sc.start, i); });
    $('#sc-range').textContent = fmtDate(days[0], { month: 'short', day: 'numeric' }) + ' – ' + fmtDate(days[6], { month: 'short', day: 'numeric', year: 'numeric' });
    // Hours shown: the clinic's opening hours, widened to include anything booked or blocked outside them
    var lo = 24 * 60, hi = 0;
    d.hours.forEach(function (h) { if (h) { lo = Math.min(lo, hm2(h.start)); hi = Math.max(hi, hm2(h.end)); } });
    d.bookings.forEach(function (b) { lo = Math.min(lo, b.start); hi = Math.max(hi, b.start + b.minutes); });
    d.blockedTimes.forEach(function (b) { if (days.indexOf(b.date) !== -1) { lo = Math.min(lo, hm2(b.start)); hi = Math.max(hi, hm2(b.end)); } });
    if (lo >= hi) { lo = 9 * 60; hi = 17 * 60; }
    lo = Math.max(0, Math.floor(lo / 60) * 60 - 60);
    hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60 + 60);
    var top = function (m) { return ((m - lo) / 60) * H; };
    var dows = T('dows');
    var html = '<div class="sc-row sc-heads"><div class="sc-corner"></div>' + days.map(function (ds, i) {
      return '<div class="sc-dayhead' + (ds === d.today ? ' today' : '') + (ds < d.today ? ' past' : '') + '"><span>' + dows[i] + '</span><b>' + Number(ds.slice(8)) + '</b></div>';
    }).join('') + '</div>';
    html += '<div class="sc-row sc-allday"><div class="sc-corner">' + T('sc.allDay') + '</div>' + days.map(function (ds, i) {
      var blocked = d.blockedDates.indexOf(ds) !== -1;
      var closed = !d.hours[i];
      if (blocked) return '<div class="sc-adcell"><button type="button" class="sc-adblock" data-unblock-day="' + ds + '">' + T('sc.blockedAllDay') + '</button></div>';
      return '<div class="sc-adcell"><button type="button" class="sc-adadd" data-allday="' + ds + '" aria-label="' + esc(T('sc.blockDay', fmtDate(ds))) + '">' + (closed ? T('sc.kClosed') : '+') + '</button></div>';
    }).join('') + '</div>';
    html += '<div class="sc-row sc-body" style="height:' + top(hi) + 'px"><div class="sc-times">';
    for (var m = lo; m < hi; m += 60) html += '<span style="top:' + top(m) + 'px">' + fmtTime(m) + '</span>';
    html += '</div>' + days.map(function (ds, i) {
      var h = d.hours[i];
      var col = '<div class="sc-col' + (ds < d.today ? ' past' : '') + '" data-date="' + ds + '" style="background-size:100% ' + H + 'px">';
      // closed hours
      if (!h) col += '<div class="sc-closed" style="top:0;height:100%"></div>';
      else {
        if (hm2(h.start) > lo) col += '<div class="sc-closed" style="top:0;height:' + top(hm2(h.start)) + 'px"></div>';
        if (hm2(h.end) < hi) col += '<div class="sc-closed" style="top:' + top(hm2(h.end)) + 'px;bottom:0"></div>';
      }
      if (d.blockedDates.indexOf(ds) !== -1) col += '<div class="sc-dayblock" data-unblock-day="' + ds + '"></div>';
      d.google.filter(function (g) { return g.date === ds; }).forEach(function (g) {
        var s0 = Math.max(g.start, lo), e0 = Math.min(g.end, hi);
        if (e0 > s0) col += '<div class="sc-ev sc-google" style="top:' + top(s0) + 'px;height:' + Math.max(18, top(e0) - top(s0)) + 'px"><span>' + T('sc.kGoogle') + '</span></div>';
      });
      d.blockedTimes.forEach(function (b, bi) {
        if (b.date !== ds) return;
        var s0 = hm2(b.start), e0 = hm2(b.end);
        var hb = top(e0) - top(s0);
        col += '<button type="button" class="sc-ev sc-block' + (hb < 36 ? ' short' : '') + '" data-block="' + bi + '" style="top:' + top(s0) + 'px;height:' + Math.max(18, hb) + 'px"><b>' + T('sc.kBlocked') + (hb < 36 ? ' ' + fmtTime(s0) : '') + '</b><span>' + fmtTime(s0) + ' – ' + fmtTime(e0) + '</span></button>';
      });
      d.bookings.forEach(function (b, bi) {
        if (b.date !== ds) return;
        var hk = top(b.start + b.minutes) - top(b.start);
        col += '<button type="button" class="sc-ev sc-book' + (b.status === 'completed' ? ' done' : '') + (hk < 36 ? ' short' : '') + '" data-booking="' + bi + '" style="top:' + top(b.start) + 'px;height:' + Math.max(18, hk) + 'px"><b>' + fmtTime(b.start) + ' ' + esc(b.name) + '</b><span>' + esc(typeName(b.type, b.type_name)) + '</span></button>';
      });
      return col + '</div>';
    }).join('') + '</div>';
    sc.lo = lo;
    $('#sc-grid').innerHTML = html;
  }
  function closePop() { $('#sc-pop').hidden = true; }
  function openPop(html, ev) {
    var pop = $('#sc-pop');
    pop.innerHTML = html + '<button type="button" class="sc-x" data-pop-close aria-label="' + T('cancel') + '">×</button>';
    pop.hidden = false;
    var card = $('#schedule').getBoundingClientRect();
    var x = Math.min(ev.clientX - card.left + 8, card.width - pop.offsetWidth - 8);
    var y = ev.clientY - card.top + 8;
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = y + 'px';
    var first = pop.querySelector('button:not([data-pop-close]), a');
    if (first) first.focus();
  }
  function openForm(date, startMin, allDay) {
    closePop();
    var f = $('#sc-form');
    f.hidden = false;
    $('#sc-date').value = date || lastToday;
    $('#sc-last').value = '';
    $('#sc-allday').checked = !!allDay;
    if (startMin !== undefined) { $('#sc-start').value = mm2hm(startMin); $('#sc-end').value = mm2hm(Math.min(startMin + 60, 23 * 60 + 45)); }
    $('#sc-weeks').value = '1';
    $('#sc-error').textContent = '';
    syncAllDay();
    $('#sc-date').focus();
  }
  function syncAllDay() {
    var all = $('#sc-allday').checked;
    $$('.sc-timed').forEach(function (el) { el.hidden = all; });
    $$('.sc-days').forEach(function (el) { el.hidden = !all; });
  }
  function sendBlocks(body, msg) {
    return api('/api/admin/blocks', { method: 'POST', body: body }).then(function (r) {
      settings.blockedDates = r.blockedDates;
      settings.blockedTimes = r.blockedTimes;
      status($('#avail-status'), msg);
      loadSchedule();
    }).catch(function (e) { status($('#avail-status'), e.message, true); });
  }
  $('#sc-allday').addEventListener('change', syncAllDay);
  $('#sc-new').addEventListener('click', function () { openForm(lastToday, 12 * 60, false); });
  $('#sc-cancel').addEventListener('click', function () { $('#sc-form').hidden = true; });
  $('#sc-today').addEventListener('click', function () { sc.start = weekStart(lastToday || new Date().toISOString().slice(0, 10)); loadSchedule(); });
  $('#sc-prev').addEventListener('click', function () { sc.start = addDays(sc.start, -7); loadSchedule(); });
  $('#sc-next').addEventListener('click', function () { sc.start = addDays(sc.start, 7); loadSchedule(); });
  $('#sc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var date = $('#sc-date').value, all = $('#sc-allday').checked, weeks = Number($('#sc-weeks').value);
    var start = $('#sc-start').value, end = $('#sc-end').value, last = $('#sc-last').value || date;
    if (!date || (!all && (!start || !end || end <= start)) || (all && last < date)) { $('#sc-error').textContent = T(all ? 'av.rangeErr' : 'hb.err'); return; }
    var add = [];
    for (var w = 0; w < weeks; w++) {
      if (all) { for (var dd = date; dd <= last && add.length < 500; dd = addDays(dd, 1)) add.push({ date: addDays(dd, w * 7), allDay: true }); }
      else add.push({ date: addDays(date, w * 7), start: start, end: end });
    }
    $('#sc-form').hidden = true;
    sc.start = weekStart(date);
    sendBlocks({ add: add }, T('sc.added', add.length));
  });
  $('#sc-grid').addEventListener('click', function (e) {
    var d = sc.data;
    var t;
    if ((t = e.target.closest('[data-booking]'))) {
      var b = d.bookings[Number(t.dataset.booking)];
      openPop('<b class="sc-pop-title">' + esc(b.name) + '</b><p>' + fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmtTime(b.start) + ' – ' + fmtTime(b.start + b.minutes) + '</p>' +
        '<p>' + esc(typeName(b.type, b.type_name)) + ' · ' + T(b.mode === 'telemedicine' ? 'mode.tele' : 'mode.in') + '</p>' +
        '<p><a href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">' + esc(b.phone) + '</a>' + (b.email ? ' · <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>' : '') + '</p>' +
        '<div class="row"><button type="button" class="btn ghost sm" data-goto-bookings>' + T('sc.openBookings') + '</button></div>', e);
      return;
    }
    if ((t = e.target.closest('[data-block]'))) {
      var bl = d.blockedTimes[Number(t.dataset.block)];
      openPop('<b class="sc-pop-title">' + T('sc.kBlocked') + '</b><p>' + fmtDate(bl.date, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmtTime(hm2(bl.start)) + ' – ' + fmtTime(hm2(bl.end)) + '</p>' +
        '<div class="row"><button type="button" class="btn sm" data-unblock-time="' + t.dataset.block + '">' + T('hb.remove') + '</button></div>', e);
      return;
    }
    if ((t = e.target.closest('[data-unblock-day]'))) {
      var ds = t.dataset.unblockDay;
      openPop('<b class="sc-pop-title">' + T('sc.blockedAllDay') + '</b><p>' + fmtDate(ds) + '</p><div class="row"><button type="button" class="btn sm" data-unblock-allday="' + ds + '">' + T('hb.remove') + '</button></div>', e);
      return;
    }
    if ((t = e.target.closest('[data-allday]'))) { openForm(t.dataset.allday, undefined, true); return; }
    var col = e.target.closest('.sc-col');
    if (col) {
      var y = e.clientY - col.getBoundingClientRect().top;
      var m = sc.lo + Math.floor((y / H) * 2) * 30; // round down to the half hour
      openForm(col.dataset.date, m, false);
    }
  });
  $('#sc-pop').addEventListener('click', function (e) {
    var t;
    if (e.target.closest('[data-pop-close]')) { closePop(); return; }
    if (e.target.closest('[data-goto-bookings]')) { closePop(); $('.tabs [data-tab="bookings"]').click(); return; }
    if ((t = e.target.closest('[data-unblock-time]'))) {
      var bl = sc.data.blockedTimes[Number(t.dataset.unblockTime)];
      closePop();
      sendBlocks({ remove: [{ date: bl.date, start: bl.start, end: bl.end }] }, T('sc.unblocked'));
      return;
    }
    if ((t = e.target.closest('[data-unblock-allday]'))) { closePop(); sendBlocks({ remove: [{ date: t.dataset.unblockAllday, allDay: true }] }, T('sc.unblocked')); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePop(); } });

  $('#save-availability').addEventListener('click', function () {
    readTypes();
    readGoogle();
    settings.hours = $$('#hours .hour').map(function (row) {
      var on = $('input[type="checkbox"]', row).checked;
      var t = $$('input[type="time"]', row);
      return on ? { start: t[0].value, end: t[1].value } : null;
    });
    ['slotStep', 'bufferMinutes', 'minNoticeHours', 'maxDaysAhead', 'retentionDays'].forEach(function (k) { settings[k] = Number($('#' + k).value); });
    var today = new Date().toISOString().slice(0, 10);
    settings.blockedDates = settings.blockedDates.filter(function (d) { return d >= addDays(today, -1); });
    settings.blockedTimes = settings.blockedTimes.filter(function (b) { return b.date >= addDays(today, -1); });
    api('/api/admin/settings', { method: 'PUT', body: settings }).then(function (s) {
      settings = s;
      renderAvailability();
      fillTypeSelect();
      status($('#avail-status'), T('av.saved'));
      loadSchedule();
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
    api('/api/admin/settings', { method: 'PUT', body: next }).then(function (s) { settings = s; status(st, T('cl.saved')); })
      .catch(function (e2) { status(st, e2.message, true); });
  });

  applyLang();
})();
