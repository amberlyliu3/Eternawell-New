// In-page editor. The Worker adds this script to a v8 page only for a signed-in admin
// opening the page with ?edit=1 (inside the admin's "Edit website" tab).
(function () {
  var html = document.documentElement;
  html.classList.add('ew-editing');
  document.querySelectorAll('[data-reveal]').forEach(function (el) { el.classList.add('in'); });

  var original = new Map();
  var changed = new Map(); // key -> html string, or { src, alt } for photos
  var top = window.parent !== window ? window.parent : null;

  function notify(msg) {
    if (top) top.postMessage(msg, location.origin);
    var bar = document.querySelector('.ew-bar-count');
    if (bar && msg.type === 'ew-dirty') bar.textContent = msg.count ? msg.count + ' unsaved' : 'No changes';
  }
  function report() { notify({ type: 'ew-dirty', count: changed.size }); }

  // ---------- text ----------
  document.querySelectorAll('[data-edit]').forEach(function (el) {
    var key = el.getAttribute('data-edit');
    original.set(key, el.innerHTML);
    el.contentEditable = 'true';
    el.spellcheck = true;
    if (key.indexOf('shared:') === 0) el.classList.add('ew-shared');
    el.addEventListener('input', function () {
      // A filled-in blank loses its highlight once the brackets are gone.
      el.querySelectorAll('.todo').forEach(function (t) { if (t.textContent.indexOf('[') === -1) t.replaceWith.apply(t, Array.prototype.slice.call(t.childNodes)); });
      if (el.classList.contains('todo') && el.textContent.indexOf('[') === -1) el.classList.remove('todo');
      if (el.innerHTML === original.get(key)) changed.delete(key); else changed.set(key, el.innerHTML);
      el.classList.toggle('ew-changed', changed.has(key));
      report();
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) document.execCommand('insertLineBreak'); }
    });
    el.addEventListener('paste', function (e) {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
    });
  });

  // Links and forms must not navigate while editing.
  document.addEventListener('click', function (e) { if (e.target.closest('a')) e.preventDefault(); }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  // ---------- photos ----------
  function resize(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not read that image.')); }, 'image/jpeg', 0.84);
      };
      img.onerror = function () { reject(new Error('Could not read that image. Please use a JPEG or PNG photo.')); };
      img.src = URL.createObjectURL(file);
    });
  }

  document.querySelectorAll('[data-edit-img]').forEach(function (el) {
    var key = el.getAttribute('data-edit-img');
    var fig = el.tagName === 'IMG' ? el.closest('figure') : el;
    if (!fig) return;
    var label = (fig.querySelector('.ph-label') || {}).textContent || '';
    var alt = label.replace(/^(Photography|Portrait|Photo)\s*·\s*/i, '').replace(/\(photo to come\)/i, '').trim();
    fig.classList.add('ew-img');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ew-img-btn';
    btn.textContent = fig.querySelector('img') ? 'Replace photo' : 'Add photo';
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.hidden = true;
    fig.append(btn, input);
    btn.addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
    input.addEventListener('change', function () {
      var file = input.files[0];
      if (!file) return;
      btn.textContent = 'Uploading…';
      btn.disabled = true;
      resize(file).then(function (blob) {
        return fetch('/api/admin/media', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob });
      }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Upload failed.'); return d; }); })
        .then(function (d) {
          var img = fig.querySelector('img');
          if (!img) { img = document.createElement('img'); img.loading = 'lazy'; fig.prepend(img); }
          img.removeAttribute('srcset');
          img.src = d.url;
          img.alt = alt;
          changed.set(key, { src: d.url, alt: alt });
          fig.classList.add('ew-changed');
          btn.textContent = 'Replace photo';
          report();
        })
        .catch(function (err) { notify({ type: 'ew-error', message: err.message }); btn.textContent = 'Replace photo'; })
        .then(function () { btn.disabled = false; input.value = ''; });
    });
  });

  // ---------- save ----------
  function save() {
    if (!changed.size) return;
    var changes = {};
    changed.forEach(function (v, k) { changes[k] = v; });
    fetch('/api/admin/content', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: changes }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not save.'); return d; }); })
      .then(function () {
        changed.forEach(function (v, k) { if (typeof v === 'string') original.set(k, v); });
        changed.clear();
        document.querySelectorAll('.ew-changed').forEach(function (el) { el.classList.remove('ew-changed'); });
        notify({ type: 'ew-saved' });
        report();
      })
      .catch(function (err) { notify({ type: 'ew-error', message: err.message }); });
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'ew-save') save();
  });

  // Opened on its own (not inside the admin): show a small save bar.
  if (!top) {
    var bar = document.createElement('div');
    bar.className = 'ew-bar';
    bar.innerHTML = '<span>Editing mode</span><span class="ew-bar-count">No changes</span><button type="button">Save</button>';
    bar.querySelector('button').addEventListener('click', save);
    document.body.append(bar);
  }
  report();
})();
