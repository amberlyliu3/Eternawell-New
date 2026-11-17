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
  var frame = document.getElementById('editor');
  var mview = 'all';
  var lastPage = 'home';
  var view = 'upcoming';
  var avView = 'schedule'; // Availability: 'schedule' or 'settings'
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
    if (settings) { if (avDirty) readAvailabilityForm(); fillTypeSelect(); renderAvailability(); }
    if ($('#save-bar')) $('#save-bar-msg').textContent = T(avDirty ? 'av.unsavedBar' : 'av.saveHint');
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
    readUrl();
    showTab(tabFromUrl());
  }

  // ---------- sections and their addresses (/admin/bookings, /admin/website?lang=zh&page=about, …) ----------
  var TABS = ['bookings', 'messages', 'website', 'availability', 'clinic'];
  function tabFromUrl() {
    var m = location.pathname.match(/^\/admin\/([a-z]+)/);
    return m && TABS.indexOf(m[1]) !== -1 ? m[1] : 'bookings';
  }
  function urlFor(tab) {
    if (tab === 'website') return '/admin/website?lang=' + siteLang + '&page=' + $('#page').value;
    if (tab === 'bookings' && view !== 'upcoming') return '/admin/bookings?view=' + view;
    if (tab === 'messages' && mview !== 'all') return '/admin/messages?view=' + mview;
    if (tab === 'availability' && avView !== 'schedule') return '/admin/availability?view=' + avView;
    return '/admin/' + tab;
  }
  function setUrl(tab, push) {
    var u = urlFor(tab);
    if (u === location.pathname + location.search) return;
    if (push) history.pushState(null, '', u); else history.replaceState(null, '', u);
  }
  // Restores the bookings filter, messages filter, and the editor's language and page from the address
  function readUrl() {
    var q = new URLSearchParams(location.search);
    var tab = tabFromUrl();
    var v = q.get('view');
    view = tab === 'bookings' && ['upcoming', 'past', 'cancelled', 'all'].indexOf(v) !== -1 ? v : 'upcoming';
    mview = tab === 'messages' && ['all', 'new', 'read'].indexOf(v) !== -1 ? v : 'all';
    showAvView(tab === 'availability' && v === 'settings' ? 'settings' : 'schedule');
    $$('.seg button[data-view]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.view === view)); });
    $$('[data-mview]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.mview === mview)); });
    if (tab === 'website') {
      var lang = q.get('lang') === 'zh' ? 'zh' : 'en';
      var page = PAGES.indexOf(q.get('page')) !== -1 ? q.get('page') : 'home';
      if (lang !== siteLang || page !== $('#page').value) {
        siteLang = lang;
        $$('#site-lang button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.site === lang)); });
        $('#page').value = page;
        lastPage = page;
        if (frame.src) loadPage();
      }
    }
  }
  function showTab(tab) {
    $$('.tabs button').forEach(function (x) { if (x.dataset.tab === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    $$('.panel').forEach(function (p) { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'website' && !frame.src) loadPage();
    if (tab === 'bookings') loadBookings();
    if (tab === 'messages') loadMessages();
    if (tab === 'availability') loadSchedule();
  }
  $$('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (dirtyCount && b.dataset.tab !== 'website') { status($('#edit-status'), T('web.unsaved'), true); return; }
      if (b.dataset.tab !== tabFromUrl()) setUrl(b.dataset.tab, true);
      showTab(b.dataset.tab);
    });
  });
  window.addEventListener('popstate', function () {
    if (dirtyCount) { setUrl('website', true); status($('#edit-status'), T('web.unsaved'), true); return; }
    readUrl();
    showTab(tabFromUrl());
  });

  // ---------- bookings ----------
  $$('.seg button[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      view = b.dataset.view;
      $$('.seg button[data-view]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      setUrl('bookings', false);
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
  $$('[data-mview]').forEach(function (b) {
    b.addEventListener('click', function () {
      mview = b.dataset.mview;
      $$('[data-mview]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      setUrl('messages', false);
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
  var siteLang = 'en';
  function pagePath(p) { return '/v8/' + (siteLang === 'zh' ? 'zh/' : '') + (p === 'home' ? '' : p + '/'); }
  function loadPage() {
    dirty(0);
    frame.src = pagePath($('#page').value) + '?edit=1';
    if (tabFromUrl() === 'website') setUrl('website', false);
    loadEdited();
  }
  function fillPages() {
    var sel = $('#page');
    var cur = sel.value || 'home';
    sel.innerHTML = PAGES.map(function (p) { return '<option value="' + p + '">' + esc(T('page.' + p)) + '</option>'; }).join('');
    sel.value = cur;
  }
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
  window.addEventListener('beforeunload', function (e) { if (dirtyCount || avDirty) { e.preventDefault(); e.returnValue = ''; } });

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
  // Two views: the Schedule (week calendar) and Settings (hours, visit types, rules, connected calendars)
  function showAvView(v) {
    avView = v;
    $$('#av-view button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.av === v)); });
    $$('[data-avpane]').forEach(function (p) { p.hidden = p.dataset.avpane !== v; });
    $('[data-panel="availability"]').classList.toggle('on-schedule', v === 'schedule');
  }
  $$('#av-view button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.av === avView) return;
      showAvView(b.dataset.av);
      setUrl('availability', true);
      if (avView === 'schedule') loadSchedule();
    });
  });
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
    renderApple();
  }

  // ---------- Google Calendar ----------
  function renderGoogle() {
    var g = settings.google;
    renderCals(g.calendars);
    fillBookingCal(g.bookingCalendar);
    $('#g-detail').value = g.detail;
    api('/api/admin/google').then(function (d) {
      var st = $('#g-status');
      $('#g-share').hidden = !d.keyAdded;
      $('#g-email').textContent = d.serviceEmail;
      if (!d.keyAdded) { st.textContent = T('g.noKey'); st.className = 'g-status bad'; return; }
      if (!g.calendars.length) { st.textContent = T('g.noCalsYet'); st.className = 'g-status'; return; }
      if (d.status && !d.status.ok) { st.textContent = T('g.problemAt', I.srv(d.status.message), fmtStamp(d.status.at)); st.className = 'g-status bad'; return; }
      st.textContent = T('g.connected') + (d.status ? ' · ' + I.srv(d.status.message) : '.'); st.className = 'g-status good';
    });
  }
  // One row per connected calendar: name, calendar ID, "block busy times", test and remove
  function renderCals(cals) {
    $('#g-cals').innerHTML = cals.length ? cals.map(function (c, i) {
      return '<div class="g-cal" data-row="' + i + '">' +
        '<div class="grid">' +
        '<label class="field"><span>' + T('g.calName') + '</span><input data-k="label" value="' + esc(c.label) + '" placeholder="' + esc(T('g.calN', i + 1)) + '"></label>' +
        '<label class="field"><span>' + T('g.calId') + '</span><input data-k="id" value="' + esc(c.id) + '" placeholder="' + esc(T('g.calPh')) + '" spellcheck="false" autocomplete="off"></label>' +
        '</div>' +
        '<label class="check"><input type="checkbox" data-k="busy"' + (c.busy ? ' checked' : '') + '><span>' + T('g.calBusy') + '</span></label>' +
        '<fieldset class="g-kinds"' + (c.busy ? '' : ' disabled') + '><legend>' + T('g.which') + '</legend>' +
        ['busy', 'free', 'allDay'].map(function (k) {
          return '<label class="check"><input type="checkbox" data-kind="' + k + '"' + (!c.block || c.block[k] !== false ? ' checked' : '') + '><span>' + T('g.ev.' + k) + '</span></label>';
        }).join('') + '</fieldset>' +
        '<div class="row"><button type="button" class="btn ghost sm" data-gtest>' + T('g.test') + '</button><button type="button" class="btn ghost sm danger" data-gremove>' + T('g.removeCal') + '</button></div>' +
        '<p class="status g-cal-result" aria-live="polite"></p></div>';
    }).join('') : '<p class="muted">' + T('g.noCals') + '</p>';
  }
  function readCals() {
    return $$('#g-cals .g-cal').map(function (row) {
      var block = {};
      $$('[data-kind]', row).forEach(function (x) { block[x.dataset.kind] = x.checked; });
      return { id: $('[data-k="id"]', row).value.trim(), label: $('[data-k="label"]', row).value.trim(), busy: $('[data-k="busy"]', row).checked, block: block };
    });
  }
  function fillBookingCal(selected) {
    var cals = readCals().filter(function (c) { return c.id; });
    var sel = $('#g-booking');
    sel.innerHTML = '<option value="">' + esc(T('g.noBookingCal')) + '</option>' + cals.map(function (c, i) {
      return '<option value="' + esc(c.id) + '">' + esc(c.label || T('g.calN', i + 1)) + '</option>';
    }).join('');
    sel.value = cals.some(function (c) { return c.id === selected; }) ? selected : '';
  }
  function readGoogle() {
    settings.google = { calendars: readCals().filter(function (c) { return c.id; }), bookingCalendar: $('#g-booking').value, detail: $('#g-detail').value };
  }
  $('#g-addcal').addEventListener('click', function () {
    var cals = readCals();
    cals.push({ id: '', label: '', busy: true, block: { busy: true, free: true, allDay: true } });
    var booking = $('#g-booking').value;
    renderCals(cals);
    fillBookingCal(booking);
    $$('#g-cals .g-cal').pop().querySelector('[data-k="label"]').focus();
  });
  $('#g-cals').addEventListener('input', function () { fillBookingCal($('#g-booking').value); });
  // The Busy / Free / All-day choices only apply while the calendar blocks booking
  $('#g-cals').addEventListener('change', function (e) {
    if (e.target.dataset.k !== 'busy') return;
    $('.g-kinds', e.target.closest('.g-cal')).disabled = !e.target.checked;
  });
  $('#g-cals').addEventListener('click', function (e) {
    var row = e.target.closest('.g-cal');
    if (!row) return;
    if (e.target.closest('[data-gremove]')) {
      var cals = readCals();
      cals.splice(Number(row.dataset.row), 1);
      var booking = $('#g-booking').value;
      renderCals(cals);
      fillBookingCal(booking);
      return;
    }
    var b = e.target.closest('[data-gtest]');
    if (!b) return;
    var out = $('.g-cal-result', row);
    b.disabled = true;
    status(out, T('g.testing'));
    api('/api/admin/google/test', { method: 'POST', body: { calendarId: $('[data-k="id"]', row).value.trim() } })
      .then(function (d) { out.textContent = I.srv(d.message); out.classList.toggle('is-error', !d.ok); })
      .catch(function (e2) { status(out, e2.message, true); })
      .then(function () { b.disabled = false; });
  });
  $('#g-copy').addEventListener('click', function () {
    navigator.clipboard.writeText($('#g-email').textContent).then(function () { status($('#g-result'), T('g.copied')); });
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
    var now = { calendars: readCals().filter(function (c) { return c.id; }), bookingCalendar: $('#g-booking').value, detail: $('#g-detail').value };
    return JSON.stringify(now) !== JSON.stringify({ calendars: g.calendars, bookingCalendar: g.bookingCalendar, detail: g.detail }) ||
      JSON.stringify(appleForm()) !== JSON.stringify(settings.apple);
  }

  // ---------- Apple Calendar (iCloud) ----------
  // The doctor's iCloud calendars as last found, so the list shows every calendar, not only the ones in use
  var appleFound = null;
  var appleAdded = false;
  function renderApple() {
    renderAppleCals();
    api('/api/admin/apple').then(function (d) {
      appleAdded = d.added;
      $('#ap-setup').open = !d.added;
      $('#ap-find').hidden = !d.added;
      var st = $('#ap-status');
      if (!d.added) { st.textContent = T('ap.noKey'); st.className = 'g-status bad'; return; }
      if (d.status && !d.status.ok) { st.textContent = T('g.problemAt', I.srv(d.status.message), fmtStamp(d.status.at)); st.className = 'g-status bad'; }
      else { st.textContent = T('ap.connected', d.appleId) + (d.status ? ' · ' + I.srv(d.status.message) : '.'); st.className = 'g-status good'; }
      if (!appleFound) findApple();
    });
  }
  // Saved calendars first, then any others found in iCloud
  function appleRows(a) {
    var rows = a.calendars.map(function (c) {
      var f = appleFound && appleFound.filter(function (x) { return x.url === c.url; })[0];
      return { url: c.url, label: f ? f.name : c.label, color: f ? f.color : '', busy: c.busy, block: c.block, missing: !!appleFound && !f };
    });
    (appleFound || []).forEach(function (f) {
      if (!rows.some(function (r) { return r.url === f.url; })) rows.push({ url: f.url, label: f.name, color: f.color, busy: false, block: { busy: true, free: true, allDay: true } });
    });
    return rows;
  }
  function renderAppleCals(rows, booking) {
    rows = rows || appleRows(settings.apple);
    booking = booking === undefined ? settings.apple.bookingCalendar : booking;
    $('#ap-cals').innerHTML = rows.length ? rows.map(function (c) {
      return '<div class="g-cal ap-cal" data-url="' + esc(c.url) + '" data-label="' + esc(c.label) + '">' +
        '<p class="ap-name"><span class="ap-dot"' + (c.color ? ' style="background:' + esc(c.color) + '"' : '') + '></span>' + esc(c.label || T('g.calN', '')) +
        (c.missing ? ' <span class="ap-missing">' + T('ap.missing') + '</span>' : '') + '</p>' +
        '<label class="check"><input type="checkbox" data-k="busy"' + (c.busy ? ' checked' : '') + '><span>' + T('g.calBusy') + '</span></label>' +
        '<fieldset class="g-kinds"' + (c.busy ? '' : ' disabled') + '><legend>' + T('g.which') + '</legend>' +
        ['busy', 'free', 'allDay'].map(function (k) {
          return '<label class="check"><input type="checkbox" data-kind="' + k + '"' + (!c.block || c.block[k] !== false ? ' checked' : '') + '><span>' + T('g.ev.' + k) + '</span></label>';
        }).join('') + '</fieldset></div>';
    }).join('') : (appleAdded ? '<p class="muted">' + T('ap.noCals') + '</p>' : '');
    var sel = $('#ap-booking');
    sel.innerHTML = '<option value="">' + esc(T('g.noBookingCal')) + '</option>' + rows.map(function (c) {
      return '<option value="' + esc(c.url) + '">' + esc(c.label) + '</option>';
    }).join('');
    sel.value = rows.some(function (c) { return c.url === booking; }) ? booking : '';
  }
  // What the Apple card would save: calendars that block booking or take new bookings
  function appleForm() {
    var booking = $('#ap-booking').value;
    var cals = $$('#ap-cals .ap-cal').map(function (row) {
      var block = {};
      $$('[data-kind]', row).forEach(function (x) { block[x.dataset.kind] = x.checked; });
      return { url: row.dataset.url, label: row.dataset.label, busy: $('[data-k="busy"]', row).checked, block: block };
    }).filter(function (c) { return c.busy || c.url === booking; });
    return { calendars: cals, bookingCalendar: booking };
  }
  function readApple() { settings.apple = appleForm(); }
  function findApple() {
    var b = $('#ap-find');
    b.disabled = true;
    status($('#ap-result'), T('ap.finding'));
    api('/api/admin/apple/calendars', { method: 'POST' })
      .then(function (d) {
        if (!d.ok) { status($('#ap-result'), I.srv(d.message), true); return; }
        // keep what's been ticked but not saved yet
        var current = $$('#ap-cals .ap-cal').length ? appleForm() : settings.apple;
        appleFound = d.calendars;
        renderAppleCals(appleRows(current), current.bookingCalendar);
        if (d.message) status($('#ap-result'), I.srv(d.message), true);
        else status($('#ap-result'), T('ap.found', d.calendars.length));
      })
      .catch(function (e) { status($('#ap-result'), e.message, true); })
      .then(function () { b.disabled = false; });
  }
  $('#ap-find').addEventListener('click', findApple);
  $('#ap-cals').addEventListener('change', function (e) {
    if (e.target.dataset.k !== 'busy') return;
    $('.g-kinds', e.target.closest('.ap-cal')).disabled = !e.target.checked;
  });
  $('#ap-sync').addEventListener('click', function () {
    var b = this;
    if (dirtyAvailability()) { status($('#ap-result'), T('g.saveFirst'), true); return; }
    b.disabled = true;
    status($('#ap-result'), T('g.adding'));
    api('/api/admin/apple/sync', { method: 'POST' })
      .then(function (d) {
        var ok = !d.apple || d.apple.ok;
        var el = $('#ap-result');
        el.textContent = ok ? T('g.synced', d.count) : T('g.problem', I.srv(d.apple.message));
        el.classList.toggle('is-error', !ok);
        renderApple();
      })
      .catch(function (e) { status($('#ap-result'), e.message, true); })
      .then(function () { b.disabled = false; });
  });
  $('#hours').addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    $$('input[type="time"]', e.target.closest('.hour')).forEach(function (t) { t.disabled = !e.target.checked; });
  });

  function renderTypes() {
    $('#types').innerHTML = settings.visitTypes.map(function (t, i) {
      return '<div class="type" data-row="' + i + '" data-id="' + esc(t.id) + '">' +
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
      if (settings) { settings.blockedDates = d.blockedDates; settings.blockedTimes = d.blockedTimes; }
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
        var kind = g.src === 'apple' ? 'sc.kApple' : 'sc.kGoogle';
        if (e0 > s0) col += '<div class="sc-ev sc-google' + (g.src === 'apple' ? ' sc-apple' : '') + '" title="' + esc(T(kind) + ' · ' + g.label) + '" style="top:' + top(s0) + 'px;height:' + Math.max(18, top(e0) - top(s0)) + 'px"><span>' + (g.src === 'apple' ? 'Apple' : 'Google') + ' · ' + esc(g.label || T(kind)) + '</span></div>';
      });
      d.blockedTimes.forEach(function (b, bi) {
        if (b.date !== ds) return;
        var s0 = Math.max(hm2(b.start), lo), e0 = Math.min(hm2(b.end), hi); // only the part within the hours shown
        if (e0 <= s0) return;
        var hb = top(e0) - top(s0);
        col += '<button type="button" class="sc-ev sc-block' + (hb < 36 ? ' short' : '') + '" data-block="' + bi + '" style="top:' + top(s0) + 'px;height:' + Math.max(18, hb) + 'px"><b>' + T('sc.kBlocked') + (hb < 36 ? ' ' + fmtTime(hm2(b.start)) : '') + '</b><span>' + fmtTime(hm2(b.start)) + ' – ' + fmtTime(hm2(b.end)) + '</span></button>';
      });
      d.bookings.forEach(function (b, bi) {
        if (b.date !== ds) return;
        var hk = top(b.start + b.minutes) - top(b.start);
        col += '<button type="button" class="sc-ev sc-book' + (b.status === 'completed' ? ' done' : '') + (hk < 36 ? ' short' : '') + '" data-booking="' + bi + '" style="top:' + top(b.start) + 'px;height:' + Math.max(18, hk) + 'px"' + (b.status === 'completed' ? ' title="' + esc(T('st.completed')) + '"' : '') + '><b>' + (b.status === 'completed' ? '✓ ' : '') + fmtTime(b.start) + ' ' + esc(b.name) + '</b><span>' + esc(typeName(b.type, b.type_name)) + '</span></button>';
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
  // Block time form, like creating an event in Google Calendar: a start and end (date and time, or all day),
  // optionally repeated daily, every weekday or weekly until a date.
  function openForm(date, startMin, allDay) {
    closePop();
    $('#sc-form').hidden = false;
    $('#sc-date').value = date || lastToday;
    $('#sc-last').value = date || lastToday;
    $('#sc-allday').checked = !!allDay;
    if (startMin !== undefined) { $('#sc-start').value = mm2hm(startMin); $('#sc-end').value = mm2hm(Math.min(startMin + 60, 23 * 60 + 45)); }
    $('#sc-repeat').value = 'none';
    $('#sc-until').value = addDays(date || lastToday, 27);
    $('#sc-error').textContent = '';
    syncForm();
    $('#sc-date').focus();
  }
  function syncForm() {
    var all = $('#sc-allday').checked;
    $$('.sc-timed, .sc-dash').forEach(function (el) { el.hidden = all; });
    var start = $('#sc-date').value;
    if (start && (!$('#sc-last').value || $('#sc-last').value < start)) $('#sc-last').value = start;
    if (start) $('#sc-weekly-opt').textContent = T('sc.weekly', T('days')[new Date(Date.parse(start + 'T00:00:00Z')).getUTCDay()]);
    $('#sc-until-wrap').hidden = $('#sc-repeat').value === 'none';
    var items = blockItems();
    $('#sc-summary').textContent = items && items.length ? T('sc.willBlock', items.length) : '';
  }
  // Turns the form into blocks: whole days, or hours on a day. A timed span across several days blocks from the
  // start time to midnight, the days in between, and midnight to the end time.
  function blockItems() {
    var start = $('#sc-date').value, end = $('#sc-last').value || start, all = $('#sc-allday').checked;
    var t0 = $('#sc-start').value, t1 = $('#sc-end').value, rep = $('#sc-repeat').value, until = $('#sc-until').value;
    if (!start || end < start) return null;
    if (!all && (!t0 || !t1 || (end === start && t1 <= t0))) return null;
    var span = (dayNum(end) - dayNum(start));
    function one(day) {
      var out = [];
      if (all) { for (var i = 0; i <= span; i++) out.push({ date: addDays(day, i), allDay: true }); return out; }
      if (span === 0) return [{ date: day, start: t0, end: t1 }];
      out.push({ date: day, start: t0, end: '23:59' });
      for (var j = 1; j < span; j++) out.push({ date: addDays(day, j), allDay: true });
      if (t1 > '00:00') out.push({ date: addDays(day, span), start: '00:00', end: t1 });
      return out;
    }
    if (rep === 'none') return one(start);
    if (!until || until < start) return null;
    var items = [];
    for (var d = start; d <= until && items.length < 500; d = addDays(d, rep === 'weekly' ? 7 : 1)) {
      var w = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
      if (rep === 'weekdays' && (w === 0 || w === 6)) continue;
      items = items.concat(one(d));
    }
    return items.slice(0, 500);
  }
  function dayNum(d) { return Date.parse(d + 'T00:00:00Z') / 864e5; }
  ['#sc-date', '#sc-last', '#sc-start', '#sc-end', '#sc-until', '#sc-repeat', '#sc-allday'].forEach(function (id) {
    $(id).addEventListener('input', syncForm);
    $(id).addEventListener('change', syncForm);
  });
  function sendBlocks(body, msg) {
    return api('/api/admin/blocks', { method: 'POST', body: body }).then(function (r) {
      settings.blockedDates = r.blockedDates;
      settings.blockedTimes = r.blockedTimes;
      status($('#avail-status'), msg);
      loadSchedule();
    }).catch(function (e) { status($('#avail-status'), e.message, true); });
  }
  $('#sc-new').addEventListener('click', function () { openForm(lastToday, 12 * 60, false); });
  $('#sc-cancel').addEventListener('click', function () { $('#sc-form').hidden = true; });
  $('#sc-today').addEventListener('click', function () { sc.start = weekStart(lastToday || new Date().toISOString().slice(0, 10)); loadSchedule(); });
  $('#sc-prev').addEventListener('click', function () { sc.start = addDays(sc.start, -7); loadSchedule(); });
  $('#sc-next').addEventListener('click', function () { sc.start = addDays(sc.start, 7); loadSchedule(); });
  $('#sc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var add = blockItems();
    if (!add || !add.length) { $('#sc-error').textContent = T('sc.formErr'); return; }
    $('#sc-form').hidden = true;
    sc.start = weekStart($('#sc-date').value);
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

  // The save bar at the bottom lights up when hours, visit types, rules or calendars change (the Schedule saves itself)
  var avDirty = false;
  function markAvailability(on) {
    avDirty = on;
    $('#save-bar').classList.toggle('dirty', on);
    $('#save-bar-msg').textContent = T(on ? 'av.unsavedBar' : 'av.saveHint');
  }
  $('[data-panel="availability"] .cols').addEventListener('input', function (e) { if (!e.target.closest('#schedule')) markAvailability(true); });
  $('[data-panel="availability"] .cols').addEventListener('change', function (e) { if (!e.target.closest('#schedule')) markAvailability(true); });
  $('[data-panel="availability"] .cols').addEventListener('click', function (e) {
    if (e.target.closest('#add-type, #types [data-remove], #g-addcal, [data-gremove]')) markAvailability(true);
  });

  // Copies the availability forms into `settings` (before saving, or before redrawing them in another language)
  function readAvailabilityForm() {
    readTypes();
    readGoogle();
    readApple();
    settings.hours = $$('#hours .hour').map(function (row) {
      var on = $('input[type="checkbox"]', row).checked;
      var t = $$('input[type="time"]', row);
      return on ? { start: t[0].value, end: t[1].value } : null;
    });
    ['slotStep', 'bufferMinutes', 'minNoticeHours', 'maxDaysAhead', 'retentionDays'].forEach(function (k) { settings[k] = Number($('#' + k).value); });
  }

  $('#save-availability').addEventListener('click', function () {
    readAvailabilityForm();
    var today = new Date().toISOString().slice(0, 10);
    settings.blockedDates = settings.blockedDates.filter(function (d) { return d >= addDays(today, -1); });
    settings.blockedTimes = settings.blockedTimes.filter(function (b) { return b.date >= addDays(today, -1); });
    api('/api/admin/settings', { method: 'PUT', body: settings }).then(function (s) {
      settings = s;
      renderAvailability();
      fillTypeSelect();
      markAvailability(false);
      var msg = $('#save-bar-msg');
      msg.textContent = T('av.saved');
      setTimeout(function () { if (!avDirty) msg.textContent = T('av.saveHint'); }, 4000);
      loadSchedule();
    }).catch(function (e) { $('#save-bar-msg').textContent = e.message; });
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
