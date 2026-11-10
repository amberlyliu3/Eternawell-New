// Online booking: visit type → date → time → details. No account needed. English or Chinese, from <html lang>.
// Talks to the Worker API (/api/booking-info, /api/availability, /api/bookings).
(function () {
  var root = document.getElementById('booking');
  if (!root) return;
  var zh = document.documentElement.lang.indexOf('zh') === 0;
  var T = zh ? {
    visit: '就诊类型', date: '日期', time: '时间', details: '您的信息',
    minutes: function (n) { return n + ' 分钟'; },
    howMeet: '就诊方式', inPerson: '到诊', inPersonSub: '贝尔维尤诊所', tele: '远程视频', teleSub: '在家通过安全视频就诊',
    name: '姓名', phone: '手机号码', email: '电子邮箱', company: '公司',
    consent: function (href) { return '我同意 EternaWell Medicine 收集本表中的信息（包括我选择的就诊类型），用于安排就诊并就此与我联系，详见<a href="' + href + '">消费者健康数据隐私政策</a>。'; },
    submit: '确认预约', booking: '正在预约…', prev: '上个月', next: '下个月', available: '可预约', notAvailable: '，不可预约',
    chooseDate: '请选择日期以查看可预约时间。', loadingTimes: '正在加载时间…', pacific: '太平洋时间',
    noTimes: '这一天已没有可预约时间，请选择其他日期。', unavailable: '目前无法在线预约。',
    daysOpen: function (n, m) { return m + '有 ' + n + ' 天可预约。'; }, noneOpen: function (m) { return m + '没有可预约时间。'; },
    timesOpen: function (n, d) { return d + '有 ' + n + ' 个可预约时间。'; },
    errDateTime: '请选择日期和时间。', errName: '请填写您的姓名。', errPhone: '请填写可以联系到您的电话号码。', errEmail: '请检查您的电子邮箱地址。', errConsent: '请勾选同意框后再预约。', errGeneric: '出了点问题。',
    callOrText: function (link) { return '请致电或发短信至 ' + link + '。'; }, ifRepeats: '如果问题持续，',
    booked: '预约成功', at: ' ', thanks: function (n, tele) { return '谢谢您，' + n + '。我们会在就诊前与您联系确认细节' + (tele ? '，并发送视频链接' : '') + '。'; },
    manageLink: '需要取消？请保存此私人链接：', yourBooking: '您的预约', loadingBooking: '正在加载您的预约…',
    cancelled: '此预约已取消。', bookNew: '预约新的时间', done: '此次就诊已完成。', cantMake: '无法前来？请在下方取消，准备好后再预约新的时间。',
    cancel: '取消此预约', sure: '确定取消', notFound: '找不到该预约。', modeTele: '远程视频（安全视频）', modeIn: '到诊，贝尔维尤诊所',
    dows: ['日', '一', '二', '三', '四', '五', '六'], locale: 'zh-CN',
  } : {
    visit: 'Visit type', date: 'Date', time: 'Time', details: 'Your details',
    minutes: function (n) { return n + ' minutes'; },
    howMeet: 'How you\'d like to meet', inPerson: 'In person', inPersonSub: 'Our Bellevue office', tele: 'Telemedicine', teleSub: 'Secure video from home',
    name: 'Full name', phone: 'Mobile phone', email: 'Email', company: 'Company',
    consent: function (href) { return 'I consent to EternaWell Medicine collecting the information on this form, including the visit type I choose, to schedule my visit and contact me about it, as described in the <a href="' + href + '">Consumer Health Data Privacy Policy</a>.'; },
    submit: 'Book appointment', booking: 'Booking…', prev: 'Previous month', next: 'Next month', available: 'Available', notAvailable: ', not available',
    chooseDate: 'Choose a date to see open times.', loadingTimes: 'Loading times…', pacific: 'Pacific Time',
    noTimes: 'No open times left on this day. Please choose another date.', unavailable: 'Online booking is not available right now.',
    daysOpen: function (n, m) { return n + ' days with open times in ' + m + '.'; }, noneOpen: function (m) { return 'No open times in ' + m + '.'; },
    timesOpen: function (n, d) { return n + ' open times on ' + d + '.'; },
    errDateTime: 'Please choose a date and time.', errName: 'Please enter your name.', errPhone: 'Please enter a phone number we can reach you at.', errEmail: 'Please check your email address.', errConsent: 'Please confirm the consent box to book.', errGeneric: 'Something went wrong.',
    callOrText: function (link) { return 'Please call or text ' + link + '.'; }, ifRepeats: 'If it keeps happening, ',
    booked: 'You\'re booked', at: ' at ', thanks: function (n, tele) { return 'Thank you, ' + n + '. We\'ll contact you before your visit to confirm details' + (tele ? ' and send your video link' : '') + '.'; },
    manageLink: 'Need to cancel? Save this private link: ', yourBooking: 'Your booking', loadingBooking: 'Loading your booking…',
    cancelled: 'This booking is cancelled.', bookNew: 'Book a new time', done: 'This visit has already taken place.', cantMake: 'Can\'t make it? Cancel below and book a new time whenever you\'re ready.',
    cancel: 'Cancel this booking', sure: 'Yes, cancel it', notFound: 'We couldn\'t find that booking.', modeTele: 'Telemedicine (secure video)', modeIn: 'In person, Bellevue office',
    dows: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], locale: 'en-US',
  };

  var tel = root.dataset.tel || '';
  var phoneText = (document.querySelector('[data-set="phone"]') || {}).textContent || tel;
  var callLine = T.callOrText('<a href="tel:' + tel + '">' + esc(phoneText) + '</a>');
  var legalHref = location.pathname.replace(/book\/?$/, '') + 'legal/#health-data';

  var state = { info: null, type: '', mode: 'in-person', month: '', date: '', start: null, dates: [] };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-lang': document.documentElement.lang }, opts.headers);
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || T.errGeneric); return d; });
    });
  }
  function fmtTime(min) {
    var h = Math.floor(min / 60), m = String(min % 60).padStart(2, '0');
    if (zh) return (h < 12 ? '上午 ' : '下午 ') + ((h + 11) % 12 + 1) + ':' + m;
    return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function fmtDate(d, opts) { var p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(T.locale, Object.assign({ timeZone: 'UTC' }, opts || { weekday: 'long', month: 'long', day: 'numeric' })); }
  function monthName(m) { return fmtDate(m + '-01', { month: 'long', year: 'numeric' }); }
  function modeName(m) { return m === 'telemedicine' ? T.modeTele : T.modeIn; }
  function when(b) { return fmtDate(b.date) + T.at + fmtTime(b.start) + (zh ? '（' + T.pacific + '）' : ' (' + T.pacific + ')'); }
  function typeName(t) { return (zh && t.name_zh) || t.name; }
  function say(msg) { var l = root.querySelector('.bk-live'); if (l) l.textContent = msg; }
  function unavailable() { root.innerHTML = '<div class="booking-empty"><p class="lede">' + T.unavailable + ' ' + callLine + '</p></div>'; }

  var manage = new URLSearchParams(location.search).get('manage');
  if (manage) return showManage(manage);

  api('/api/booking-info').then(function (info) {
    state.info = info;
    if (!info.visitTypes.length) return unavailable();
    state.type = info.visitTypes[0].id;
    state.month = info.today.slice(0, 7);
    render();
    loadMonth();
  }).catch(unavailable);

  function render() {
    var info = state.info;
    root.innerHTML =
      '<form class="bk" novalidate>' +
      '<p class="bk-live visually-hidden" aria-live="polite"></p>' +
      '<div class="bk-col">' +
      '<fieldset class="bk-step"><legend><span class="bk-n">1</span>' + T.visit + '</legend><div class="bk-choices">' +
      info.visitTypes.map(function (t) {
        return '<label class="bk-choice"><input type="radio" name="type" value="' + esc(t.id) + '"' + (t.id === state.type ? ' checked' : '') + '><span><b>' + esc(typeName(t)) + '</b><small>' + T.minutes(t.minutes) + '</small></span></label>';
      }).join('') +
      '</div><div class="bk-choices bk-modes" role="group" aria-label="' + T.howMeet + '">' +
      ['in-person', 'telemedicine'].map(function (m) {
        return '<label class="bk-choice"><input type="radio" name="mode" value="' + m + '"' + (m === state.mode ? ' checked' : '') + '><span><b>' + (m === 'telemedicine' ? T.tele : T.inPerson) + '</b><small>' + (m === 'telemedicine' ? T.teleSub : T.inPersonSub) + '</small></span></label>';
      }).join('') +
      '</div></fieldset>' +
      '<fieldset class="bk-step"><legend><span class="bk-n">2</span>' + T.date + '</legend><div class="bk-cal"></div></fieldset>' +
      '</div><div class="bk-col">' +
      '<fieldset class="bk-step"><legend><span class="bk-n">3</span>' + T.time + '</legend><div class="bk-times"><p class="bk-hint">' + T.chooseDate + '</p></div></fieldset>' +
      '<fieldset class="bk-step bk-details"><legend><span class="bk-n">4</span>' + T.details + '</legend>' +
      '<label class="bk-field"><span>' + T.name + '</span><input name="name" autocomplete="name" required maxlength="100"></label>' +
      '<label class="bk-field"><span>' + T.phone + '</span><input name="phone" type="tel" autocomplete="tel" required maxlength="30"></label>' +
      '<label class="bk-field"><span>' + T.email + '</span><input name="email" type="email" autocomplete="email" required maxlength="120"></label>' +
      '<label class="bk-hp" aria-hidden="true">' + T.company + ' <input name="website" tabindex="-1" autocomplete="off"></label>' +
      '<label class="bk-consent"><input type="checkbox" name="consent" required><span>' + T.consent(legalHref) + '</span></label>' +
      '<p class="bk-summary" aria-live="polite"></p>' +
      '<p class="bk-error" role="alert"></p>' +
      '<button type="submit" class="btn btn-primary bk-submit">' + T.submit + '</button>' +
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
      say(d.dates.length ? T.daysOpen(d.dates.length, monthName(state.month)) : T.noneOpen(monthName(state.month)));
    }).catch(function (e) { showError(e.message); });
  }

  function shiftMonth(delta) {
    var p = state.month.split('-').map(Number);
    state.month = new Date(Date.UTC(p[0], p[1] - 1 + delta, 1)).toISOString().slice(0, 7);
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
    var maxMonth = new Date(Date.parse(state.info.today + 'T00:00:00Z') + state.info.maxDaysAhead * 864e5).toISOString().slice(0, 7);
    var html = '<div class="bk-cal-head"><button type="button" class="bk-nav" data-d="-1" aria-label="' + T.prev + '"' + (state.month <= minMonth ? ' disabled' : '') + '>‹</button>' +
      '<b>' + monthName(state.month) + '</b>' +
      '<button type="button" class="bk-nav" data-d="1" aria-label="' + T.next + '"' + (state.month >= maxMonth ? ' disabled' : '') + '>›</button></div>' +
      '<div class="bk-grid">' + T.dows.map(function (d) { return '<span aria-hidden="true">' + d + '</span>'; }).join('');
    for (var i = 0; i < first.getUTCDay(); i++) html += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var ds = state.month + '-' + String(d).padStart(2, '0');
      var open = state.dates.indexOf(ds) !== -1;
      html += '<button type="button" class="bk-day' + (ds === state.date ? ' on' : '') + '" data-date="' + ds + '"' + (open ? '' : ' disabled') +
        ' aria-pressed="' + (ds === state.date) + '" aria-label="' + fmtDate(ds) + (open ? '' : T.notAvailable) + '">' + d + '</button>';
    }
    html += '</div><p class="bk-legend"><span class="bk-key"></span> ' + T.available + '</p>';
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
    if (!state.date) { box.innerHTML = '<p class="bk-hint">' + T.chooseDate + '</p>'; return; }
    box.innerHTML = '<p class="bk-hint">' + T.loadingTimes + '</p>';
    var want = state.type + state.date;
    api('/api/availability?type=' + encodeURIComponent(state.type) + '&date=' + state.date).then(function (d) {
      if (want !== state.type + state.date) return;
      if (!d.times.length) { box.innerHTML = '<p class="bk-hint">' + T.noTimes + '</p>'; return; }
      box.innerHTML = '<p class="bk-hint">' + fmtDate(state.date) + ' · ' + T.pacific + '</p><div class="bk-slots">' + d.times.map(function (t) {
        return '<button type="button" class="bk-slot" data-t="' + t + '" aria-pressed="false">' + fmtTime(t) + '</button>';
      }).join('') + '</div>';
      say(T.timesOpen(d.times.length, fmtDate(state.date)));
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
      ? typeName(currentType()) + ' · ' + fmtDate(state.date) + T.at + fmtTime(state.start) + ' · ' + (state.mode === 'telemedicine' ? T.tele : T.inPerson)
      : '';
  }

  function showError(msg) {
    var el = root.querySelector('.bk-error');
    if (el) el.innerHTML = esc(msg) + ' ' + (/call or text|致电/i.test(msg) ? '' : T.ifRepeats + callLine);
  }

  function submit(e) {
    e.preventDefault();
    var f = e.target;
    root.querySelector('.bk-error').textContent = '';
    if (!state.date || state.start === null) return showError(T.errDateTime);
    if (!f.name.value.trim()) { f.name.focus(); return showError(T.errName); }
    if ((f.phone.value.match(/\d/g) || []).length < 7) { f.phone.focus(); return showError(T.errPhone); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) { f.email.focus(); return showError(T.errEmail); }
    if (!f.consent.checked) { f.consent.focus(); return showError(T.errConsent); }
    var btn = f.querySelector('.bk-submit');
    btn.disabled = true;
    btn.textContent = T.booking;
    api('/api/bookings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: state.type, mode: state.mode, date: state.date, start: state.start, name: f.name.value, phone: f.phone.value, email: f.email.value, website: f.website.value, consent: f.consent.checked }),
    }).then(function (d) {
      if (!d.booking) { showError(T.errGeneric); return; }
      var b = d.booking;
      var link = location.origin + location.pathname + '?manage=' + d.token;
      root.innerHTML = '<div class="bk-done" tabindex="-1"><span class="eyebrow">' + T.booked + '</span>' +
        '<h3>' + esc((zh && b.type_name_zh) || b.type_name) + '</h3>' +
        '<p class="lede">' + when(b) + ' · ' + modeName(b.mode) + '</p>' +
        '<p>' + T.thanks(esc(b.name), b.mode === 'telemedicine') + '</p>' +
        '<p class="bk-manage">' + T.manageLink + '<a href="' + link + '">' + esc(link) + '</a></p></div>';
      root.querySelector('.bk-done').focus();
    }).catch(function (e2) {
      showError(e2.message);
      btn.disabled = false;
      btn.textContent = T.submit;
      if (/taken|被预约/.test(e2.message)) { state.start = null; renderTimes(); loadMonth(); }
    });
  }

  function showManage(token) {
    root.innerHTML = '<div class="bk-done"><p class="bk-hint">' + T.loadingBooking + '</p></div>';
    api('/api/booking?t=' + encodeURIComponent(token)).then(function (d) {
      var b = d.booking;
      var box = root.querySelector('.bk-done');
      box.innerHTML = '<span class="eyebrow">' + T.yourBooking + '</span><h3>' + esc((zh && b.type_name_zh) || b.type_name) + '</h3>' +
        '<p class="lede">' + when(b) + ' · ' + modeName(b.mode) + '</p>' +
        (b.status === 'cancelled' ? '<p><b>' + T.cancelled + '</b></p><div class="actions"><a class="btn btn-primary" href="' + location.pathname + '">' + T.bookNew + '</a></div>'
          : b.status === 'completed' ? '<p>' + T.done + '</p>'
          : '<p>' + T.cantMake + '</p><div class="actions"><button type="button" class="btn btn-primary bk-cancel">' + T.cancel + '</button></div><p class="bk-error" role="alert"></p>');
      var c = box.querySelector('.bk-cancel');
      if (c) c.addEventListener('click', function () {
        if (c.dataset.sure !== '1') { c.dataset.sure = '1'; c.textContent = T.sure; return; }
        c.disabled = true;
        api('/api/booking/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: token }) })
          .then(function () { showManage(token); })
          .catch(function (e) { box.querySelector('.bk-error').textContent = e.message; c.disabled = false; });
      });
    }).catch(function () {
      root.querySelector('.bk-done').innerHTML = '<p class="lede">' + T.notFound + ' ' + callLine + '</p>';
    });
  }
})();
