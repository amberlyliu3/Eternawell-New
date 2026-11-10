// EternaWell Medicine on Cloudflare: serves the static site in site/, plus
//  - online booking (public API) with availability rules the doctor controls,
//  - an admin area (/admin/) where the doctor edits site text and photos and manages bookings.
// Everything is stored in one SQLite-backed Durable Object ("Store").
// The admin password is the ADMIN_PASSWORD secret (Cloudflare dashboard → Worker → Settings → Variables and Secrets).

import { DurableObject } from 'cloudflare:workers';

const TZ = 'America/Los_Angeles';
const SESSION_HOURS = 12;
const COOKIE = 'ew_admin';
const MAX_MEDIA_BYTES = 1_900_000; // a SQLite row in a Durable Object is limited to 2 MB
const MODES = ['in-person', 'telemedicine'];

const DEFAULT_SETTINGS = {
  clinic: { phone: '(206) 507-2504', address1: '2700 Richards Rd, Suite 204A', address2: 'Bellevue, WA 98005' },
  visitTypes: [
    { id: 'consult', name: 'Free 20-minute consultation', minutes: 20, active: true },
    { id: 'initial', name: 'Lab draw & full initial consultation', minutes: 60, active: true },
    { id: 'followup', name: 'Follow-up visit', minutes: 30, active: true },
  ],
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: [null, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, null],
  slotStep: 30,
  bufferMinutes: 0,
  minNoticeHours: 12,
  maxDaysAhead: 60,
  blockedDates: [], // e.g. the doctor's EZCall work days
  retentionDays: 365, // past and cancelled bookings older than this are deleted
};

// ---------- small helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const dayNum = (date) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const dateOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const weekday = (date) => new Date(dayNum(date) * 864e5).getUTCDay();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayNum(s));
const isHM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function nowLA() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Keeps only simple inline formatting in edited text: no scripts, styles or event handlers.
function sanitizeHtml(html) {
  const allowed = { b: [], strong: [], i: [], em: [], br: [], span: ['class', 'data-set'], a: ['href', 'class', 'target', 'rel'] };
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-zA-Z0-9-]+)([^>]*)>/g, (tag, name, attrs) => {
      name = name.toLowerCase();
      if (!(name in allowed)) return '';
      if (tag.startsWith('</')) return `</${name}>`;
      let out = '';
      for (const m of attrs.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        const key = m[1].toLowerCase();
        const val = m[3] ?? m[4] ?? '';
        if (!allowed[name].includes(key)) continue;
        if (key === 'href' && !/^(https?:|tel:|sms:|mailto:|\/|#)/i.test(val.trim())) continue;
        out += ` ${key}="${val.replace(/"/g, '&quot;')}"`;
      }
      return `<${name}${out}>`;
    });
}

function cleanSettings(input) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return s;
  if (input.clinic) {
    for (const k of ['phone', 'address1', 'address2']) {
      if (typeof input.clinic[k] === 'string') s.clinic[k] = input.clinic[k].trim().slice(0, 120);
    }
  }
  if (Array.isArray(input.visitTypes)) {
    const seen = new Set();
    s.visitTypes = input.visitTypes.slice(0, 20).map((t) => ({
      id: String(t.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 32) || randomHex(4),
      name: String(t.name || '').trim().slice(0, 80),
      minutes: Math.min(480, Math.max(5, Math.round(Number(t.minutes) || 30))),
      active: t.active !== false,
    })).filter((t) => t.name && !seen.has(t.id) && seen.add(t.id));
  }
  if (Array.isArray(input.hours) && input.hours.length === 7) {
    s.hours = input.hours.map((h) => (h && isHM(h.start) && isHM(h.end) && hm(h.end) > hm(h.start) ? { start: h.start, end: h.end } : null));
  }
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  s.slotStep = num(input.slotStep, 5, 240, s.slotStep);
  s.bufferMinutes = num(input.bufferMinutes, 0, 120, s.bufferMinutes);
  s.minNoticeHours = num(input.minNoticeHours, 0, 24 * 14, s.minNoticeHours);
  s.maxDaysAhead = num(input.maxDaysAhead, 1, 365, s.maxDaysAhead);
  s.retentionDays = num(input.retentionDays, 30, 3650, s.retentionDays);
  if (Array.isArray(input.blockedDates)) s.blockedDates = [...new Set(input.blockedDates.filter(isDate))].sort().slice(-1000);
  return s;
}

// ---------- storage ----------
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, date TEXT NOT NULL, start INTEGER NOT NULL, minutes INTEGER NOT NULL,
        type TEXT NOT NULL, type_name TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
        status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'online', created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date);
      CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, t INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hits_k ON hits(k, t);`);
  }

  getSettings() {
    const row = this.sql.exec("SELECT v FROM kv WHERE k = 'settings'").toArray()[0];
    return row ? cleanSettings(JSON.parse(row.v)) : structuredClone(DEFAULT_SETTINGS);
  }

  saveSettings(input) {
    const s = cleanSettings(input);
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(s));
    return s;
  }

  getContent() {
    const out = {};
    for (const r of this.sql.exec('SELECT k, v FROM content')) out[r.k] = r.v;
    return out;
  }

  getContentList() {
    return this.sql.exec('SELECT k, v, updated FROM content ORDER BY updated DESC').toArray();
  }

  saveContent(changes) {
    const now = Date.now();
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) this.sql.exec('DELETE FROM content WHERE k = ?', k);
      else this.sql.exec('INSERT INTO content (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated', k, v, now);
    }
    return this.getContent();
  }

  putMedia(type, data) {
    const id = randomHex(12);
    this.sql.exec('INSERT INTO media (id, type, data, created) VALUES (?, ?, ?, ?)', id, type, data, Date.now());
    return id;
  }

  getMedia(id) {
    const r = this.sql.exec('SELECT type, data FROM media WHERE id = ?', id).toArray()[0];
    return r ? { type: r.type, data: r.data } : null;
  }

  // Allows `limit` calls per `windowSec` for a key (an IP address and action).
  hit(key, limit, windowSec) {
    const now = Date.now();
    this.sql.exec('DELETE FROM hits WHERE t < ?', now - windowSec * 1000);
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM hits WHERE k = ?', key).one().n;
    if (n >= limit) return false;
    this.sql.exec('INSERT INTO hits (k, t) VALUES (?, ?)', key, now);
    return true;
  }

  takenOn(from, to) {
    return this.sql.exec("SELECT date, start, minutes FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed', 'completed')", from, to).toArray();
  }

  slots(settings, type, date, taken) {
    if (!isDate(date)) return [];
    const h = settings.hours[weekday(date)];
    if (!h || settings.blockedDates.includes(date)) return [];
    const now = nowLA();
    const today = dayNum(now.date);
    const d = dayNum(date);
    if (d < today || d > today + settings.maxDaysAhead) return [];
    const earliest = today * 1440 + now.min + settings.minNoticeHours * 60;
    const busy = taken.filter((b) => b.date === date).map((b) => [b.start - settings.bufferMinutes, b.start + b.minutes + settings.bufferMinutes]);
    const out = [];
    for (let t = hm(h.start); t + type.minutes <= hm(h.end); t += settings.slotStep) {
      if (d * 1440 + t < earliest) continue;
      if (busy.some(([a, b]) => t < b && t + type.minutes > a)) continue;
      out.push(t);
    }
    return out;
  }

  publicInfo() {
    const s = this.getSettings();
    return { visitTypes: s.visitTypes.filter((t) => t.active).map(({ id, name, minutes }) => ({ id, name, minutes })), maxDaysAhead: s.maxDaysAhead, today: nowLA().date, clinic: s.clinic };
  }

  availableDates(typeId, month) {
    const s = this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !/^\d{4}-\d{2}$/.test(month)) return [];
    const first = dayNum(`${month}-01`);
    const [y, m] = month.split('-').map(Number);
    const last = Date.UTC(y, m, 0) / 864e5;
    const taken = this.takenOn(dateOf(first), dateOf(last));
    const out = [];
    for (let d = first; d <= last; d++) if (this.slots(s, type, dateOf(d), taken).length) out.push(dateOf(d));
    return out;
  }

  availableTimes(typeId, date) {
    const s = this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !isDate(date)) return [];
    return this.slots(s, type, date, this.takenOn(date, date));
  }

  // Creates a booking. Online bookings must fit an open slot; the admin can add any time.
  createBooking(b, { admin = false } = {}) {
    const s = this.getSettings();
    const type = s.visitTypes.find((t) => t.id === b.type && (admin || t.active));
    if (!type) return { error: 'Please choose a visit type.' };
    if (!isDate(b.date) || !Number.isInteger(b.start) || b.start < 0 || b.start >= 1440) return { error: 'Please choose a date and time.' };
    if (!MODES.includes(b.mode)) return { error: 'Please choose in person or telemedicine.' };
    const name = String(b.name || '').trim().slice(0, 100);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const email = String(b.email || '').trim().slice(0, 120);
    if (!name) return { error: 'Please enter your name.' };
    if ((phone.match(/\d/g) || []).length < 7) return { error: 'Please enter a phone number we can reach you at.' };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please check your email address.' };
    if (!admin && !email) return { error: 'Please enter your email address.' };
    if (!admin && !this.availableTimes(type.id, b.date).includes(b.start)) return { error: 'Sorry, that time was just taken. Please choose another.' };
    const row = {
      id: randomHex(8), token: randomHex(16), date: b.date, start: b.start, minutes: type.minutes, type: type.id, type_name: type.name,
      mode: b.mode, name, phone, email, status: 'confirmed', note: String(b.note || '').slice(0, 1000), source: admin ? 'admin' : 'online', created: Date.now(),
    };
    this.sql.exec('INSERT INTO bookings (id, token, date, start, minutes, type, type_name, mode, name, phone, email, status, note, source, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...Object.values(row));
    return { booking: row };
  }

  listBookings(view) {
    const s = this.getSettings();
    const today = nowLA().date;
    const cutoff = dateOf(dayNum(today) - s.retentionDays);
    this.sql.exec('DELETE FROM bookings WHERE date < ?', cutoff);
    const q = {
      upcoming: ["SELECT * FROM bookings WHERE date >= ? AND status = 'confirmed' ORDER BY date, start", today],
      past: ["SELECT * FROM bookings WHERE (date < ? AND status != 'cancelled') OR status = 'completed' ORDER BY date DESC, start DESC", today],
      cancelled: ["SELECT * FROM bookings WHERE status = 'cancelled' AND date >= ? ORDER BY date DESC, start DESC", cutoff],
      all: ['SELECT * FROM bookings WHERE date >= ? ORDER BY date DESC, start DESC', cutoff],
    }[view] || null;
    return q ? this.sql.exec(...q).toArray() : [];
  }

  updateBooking(id, patch) {
    const row = this.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    const status = ['confirmed', 'completed', 'cancelled'].includes(patch.status) ? patch.status : row.status;
    const note = typeof patch.note === 'string' ? patch.note.slice(0, 1000) : row.note;
    this.sql.exec('UPDATE bookings SET status = ?, note = ? WHERE id = ?', status, note, id);
    return { ...row, status, note };
  }

  deleteBooking(id) {
    this.sql.exec('DELETE FROM bookings WHERE id = ?', id);
    return true;
  }

  byToken(token) {
    const r = this.sql.exec('SELECT date, start, minutes, type_name, mode, name, status FROM bookings WHERE token = ?', String(token)).toArray()[0];
    return r || null;
  }

  cancelByToken(token) {
    const r = this.sql.exec("SELECT id, date FROM bookings WHERE token = ? AND status = 'confirmed'", String(token)).toArray()[0];
    if (!r) return false;
    this.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", r.id);
    return true;
  }
}

// ---------- auth ----------
async function hmacKey(env) {
  const raw = new TextEncoder().encode(`${env.ADMIN_PASSWORD}|eternawell-session`);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeSession(env) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`admin.${exp}`));
  return `${exp}.${b64url(sig)}`;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`admin.${exp}`));
  return b64url(expected) === sig;
}

async function passwordMatches(given, env) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(given))), crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// ---------- API ----------
const store = (env) => env.STORE.get(env.STORE.idFromName('main'));

async function readJson(request, limit = 200_000) {
  const text = await request.text();
  if (text.length > limit) throw new Error('too large');
  return text ? JSON.parse(text) : {};
}

async function api(request, env, url) {
  const db = store(env);
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get('cf-connecting-ip') || 'local';

  // Writes must come from this site (blocks cross-site form posts).
  if (method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return bad('Forbidden', 403);
  }

  // Public: booking
  if (path === '/api/booking-info' && method === 'GET') return json(await db.publicInfo());
  if (path === '/api/availability' && method === 'GET') {
    const type = url.searchParams.get('type') || '';
    if (url.searchParams.get('date')) return json({ times: await db.availableTimes(type, url.searchParams.get('date')) });
    return json({ dates: await db.availableDates(type, url.searchParams.get('month') || '') });
  }
  if (path === '/api/bookings' && method === 'POST') {
    const body = await readJson(request, 10_000);
    if (body.website) return json({ ok: true }); // honeypot field filled in: a bot
    if (body.consent !== true) return bad('Please confirm the consent box to book.');
    if (!(await db.hit(`book:${ip}`, 6, 3600))) return bad('Too many bookings from this connection. Please call or text us.', 429);
    const r = await db.createBooking({ type: body.type, date: body.date, start: Number(body.start), mode: body.mode, name: body.name, phone: body.phone, email: body.email });
    if (r.error) return bad(r.error);
    const b = r.booking;
    return json({ ok: true, booking: { date: b.date, start: b.start, minutes: b.minutes, type_name: b.type_name, mode: b.mode, name: b.name }, token: b.token });
  }
  if (path === '/api/booking' && method === 'GET') {
    const b = await db.byToken(url.searchParams.get('t') || '');
    return b ? json({ booking: b }) : bad('Booking not found.', 404);
  }
  if (path === '/api/booking/cancel' && method === 'POST') {
    const body = await readJson(request, 2_000);
    return (await db.cancelByToken(body.t || '')) ? json({ ok: true }) : bad('This booking could not be cancelled. Please call or text us.', 404);
  }

  // Admin
  if (!path.startsWith('/api/admin/')) return bad('Not found', 404);
  if (!env.ADMIN_PASSWORD) return bad('The admin password has not been set up yet. Add an ADMIN_PASSWORD secret to this Worker in the Cloudflare dashboard.', 503);

  if (path === '/api/admin/login' && method === 'POST') {
    if (!(await db.hit(`login:${ip}`, 8, 900))) return bad('Too many sign-in attempts. Please wait 15 minutes.', 429);
    const body = await readJson(request, 2_000);
    if (!(await passwordMatches(body.password || '', env))) return bad('That password is not correct.', 401);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_HOURS * 3600) });
  }
  if (path === '/api/admin/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  if (!(await isAdmin(request, env))) return bad('Please sign in.', 401);

  if (path === '/api/admin/me') return json({ ok: true });
  if (path === '/api/admin/settings') {
    if (method === 'GET') return json(await db.getSettings());
    if (method === 'PUT') { contentCache = null; return json(await db.saveSettings(await readJson(request))); }
  }
  if (path === '/api/admin/content') {
    if (method === 'GET') return json({ items: await db.getContentList() });
    if (method === 'PUT') {
      const body = await readJson(request, 1_000_000);
      const changes = {};
      for (const [k, v] of Object.entries(body.changes || {})) {
        if (!/^[a-z0-9:_-]{3,80}$/i.test(k)) continue;
        if (v === null) changes[k] = null;
        else if (k.includes(':img-')) {
          const src = String(v.src || '');
          if (!/^(\/media\/[a-f0-9]+|https:\/\/[^\s"'<>]+)$/.test(src)) continue;
          changes[k] = JSON.stringify({ src, alt: String(v.alt || '').slice(0, 200) });
        } else changes[k] = sanitizeHtml(v).slice(0, 20_000);
      }
      contentCache = null;
      await db.saveContent(changes);
      return json({ ok: true, saved: Object.keys(changes).length });
    }
  }
  if (path === '/api/admin/media' && method === 'POST') {
    const type = (request.headers.get('content-type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return bad('Please upload a JPEG, PNG or WebP image.');
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_MEDIA_BYTES) return bad('That image is too large. Please use one under 1.9 MB.');
    const id = await db.putMedia(type, data);
    return json({ url: `/media/${id}` });
  }
  if (path === '/api/admin/bookings') {
    if (method === 'GET') return json({ bookings: await db.listBookings(url.searchParams.get('view') || 'upcoming'), today: nowLA().date });
    if (method === 'POST') {
      const body = await readJson(request, 10_000);
      const r = await db.createBooking({ ...body, start: Number(body.start) }, { admin: true });
      return r.error ? bad(r.error) : json({ ok: true, booking: r.booking });
    }
  }
  const m = path.match(/^\/api\/admin\/bookings\/([a-f0-9]+)$/);
  if (m) {
    if (method === 'PATCH') { const b = await db.updateBooking(m[1], await readJson(request, 5_000)); return b ? json({ booking: b }) : bad('Not found', 404); }
    if (method === 'DELETE') { await db.deleteBooking(m[1]); return json({ ok: true }); }
  }
  return bad('Not found', 404);
}

// ---------- pages ----------
let contentCache = null; // { at, content, settings } per isolate, refreshed every 10 s

async function siteData(env) {
  if (contentCache && Date.now() - contentCache.at < 10_000) return contentCache;
  const db = store(env);
  const [content, settings] = await Promise.all([db.getContent(), db.getSettings()]);
  contentCache = { at: Date.now(), content, settings };
  return contentCache;
}

async function page(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const { content, settings } = await siteData(env);
  const editing = url.searchParams.get('edit') === '1' && (await isAdmin(request, env));
  const clinic = settings.clinic;
  const tel = '+1' + clinic.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${clinic.address1} ${clinic.address2}`)}`;

  let rw = new HTMLRewriter()
    .on('[data-edit]', {
      element(el) {
        const v = content[el.getAttribute('data-edit')];
        if (v == null) return;
        el.setInnerContent(v, { html: true });
        const cls = el.getAttribute('class');
        if (cls && /\btodo\b/.test(cls)) el.setAttribute('class', cls.replace(/\btodo\b/, '').trim()); // a filled-in blank
      },
    })
    .on('[data-edit-img]', {
      element(el) {
        const raw = content[el.getAttribute('data-edit-img')];
        if (raw == null) return;
        const v = JSON.parse(raw);
        if (el.tagName === 'img') { el.setAttribute('src', v.src); el.setAttribute('alt', v.alt || ''); el.removeAttribute('data-stock'); }
        else el.prepend(`<img src="${escapeHtml(v.src)}" alt="${escapeHtml(v.alt || '')}" loading="lazy">`, { html: true });
      },
    })
    .on('[data-set]', { element(el) { const v = clinic[el.getAttribute('data-set')]; if (v) el.setInnerContent(v); } })
    .on('a[href^="tel:"], a[href^="sms:"]', { element(el) { el.setAttribute('href', el.getAttribute('href').slice(0, 4) + tel); } })
    .on('a[href^="https://www.google.com/maps"]', { element(el) { el.setAttribute('href', mapUrl); } });
  if (editing) {
    rw = rw.on('head', { element(el) { el.append('<link rel="stylesheet" href="/admin/editor.css">', { html: true }); } })
      .on('body', { element(el) { el.append('<script src="/admin/editor.js" defer></script>', { html: true }); } });
  }
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  headers.set('cache-control', editing ? 'no-store' : 'public, max-age=0, must-revalidate');
  return new Response(out.body, { status: out.status, headers });
}

async function media(env, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return new Response('Not found', { status: 404 });
  const m = await store(env).getMedia(id);
  if (!m) return new Response('Not found', { status: 404 });
  return new Response(m.data, { headers: { 'content-type': m.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname.startsWith('/media/')) return await media(env, url.pathname.slice(7));
      if (url.pathname.startsWith('/admin')) {
        const res = await env.ASSETS.fetch(request);
        const headers = new Headers(res.headers);
        headers.set('x-robots-tag', 'noindex, nofollow');
        headers.set('cache-control', 'no-store');
        headers.set('x-frame-options', 'DENY');
        return new Response(res.body, { status: res.status, headers });
      }
      if (url.pathname.startsWith('/v8/')) return await page(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      if (url.pathname.startsWith('/api/')) return bad('Something went wrong. Please try again, or call or text us.', 500);
      return env.ASSETS.fetch(request); // never take the site down: fall back to the plain page
    }
  },
};
