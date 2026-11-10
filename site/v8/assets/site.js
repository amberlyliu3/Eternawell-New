// Menu, scroll reveals, smooth scrolling
(function () {
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mobile menu
  var nav = document.querySelector('.nav');
  var btn = nav && nav.querySelector('.menu-btn');
  function setOpen(open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  if (btn) {
    btn.addEventListener('click', function () { setOpen(!nav.classList.contains('open')); });
    nav.querySelectorAll('.nav-links a').forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  // Reveal on scroll
  var items = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add('in'); });
  }

  // Smooth scrolling
  if (window.Lenis && !reduce) {
    var lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true });
    var raf = function (t) { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href*="#"]');
      if (!a) return;
      var url = new URL(a.href, location.href);
      if (url.pathname !== location.pathname || !url.hash) return;
      var target = document.querySelector(url.hash);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -96 });
      history.pushState(null, '', url.hash);
    });
  }

  // Footer: "Send the doctor a message" (stored for the doctor in the admin area)
  var msg = document.getElementById('message-form');
  if (msg) {
    var zh = document.documentElement.lang.indexOf('zh') === 0;
    var say = function (text, bad) { var st = msg.querySelector('.msg-status'); st.textContent = text; st.classList.toggle('is-error', !!bad); };
    msg.addEventListener('submit', function (e) {
      e.preventDefault();
      if (msg.website.value) return;
      if (!msg.name.value.trim()) { msg.name.focus(); return say(zh ? '请填写您的姓名。' : 'Please enter your name.', true); }
      if (!msg.contact.value.trim()) { msg.contact.focus(); return say(zh ? '请填写电子邮箱或电话号码，以便我们回复您。' : 'Please enter an email address or phone number so we can reply.', true); }
      if (!msg.message.value.trim()) { msg.message.focus(); return say(zh ? '请填写留言内容。' : 'Please write a message.', true); }
      if (!msg.consent.checked) { msg.consent.focus(); return say(zh ? '请勾选同意框后再发送留言。' : 'Please confirm the consent box to send your message.', true); }
      var btn = msg.querySelector('button[type="submit"]');
      btn.disabled = true;
      say(msg.dataset.sending);
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lang': document.documentElement.lang },
        body: JSON.stringify({ name: msg.name.value, contact: msg.contact.value, message: msg.message.value, consent: true, website: msg.website.value, page: location.pathname }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || msg.dataset.failed);
          msg.reset();
          say(msg.dataset.sent);
        });
      }).catch(function (err) { say(err.message || msg.dataset.failed, true); })
        .then(function () { btn.disabled = false; });
    });
  }
})();
