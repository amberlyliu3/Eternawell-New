// EternaWell Medicine on Cloudflare: serves the static site in site/, plus
//  - online booking (public API) with availability rules the doctor controls,
//  - an admin area (/admin/) where the doctor edits site text and photos and manages bookings.
//  - a "Send the doctor a message" form whose messages appear in the admin,
//  - optional Google Calendar sync: each booking becomes an event on the doctor's calendar, and busy times
//    on that calendar (e.g. EZCall shifts) can be hidden from online booking.
//  - optional Apple Calendar (iCloud) sync over CalDAV, the same two things for the doctor's iCloud calendars.
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
    { id: 'consult', name: 'Free 20-minute consultation', name_zh: '免费 20 分钟咨询', minutes: 20, active: true },
    { id: 'initial', name: 'Lab draw & full initial consultation', name_zh: '抽血化验及完整初诊', minutes: 60, active: true },
    { id: 'followup', name: 'Follow-up visit', name_zh: '复诊', minutes: 30, active: true },
  ],
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: [null, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, null],
  slotStep: 30,
  bufferMinutes: 0,
  minNoticeHours: 12,
  maxDaysAhead: 60,
  blockedDates: [], // e.g. the doctor's EZCall work days
  blockedTimes: [], // part of a day: { date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM' }
  retentionDays: 365, // past and cancelled bookings older than this are deleted
  // Google Calendar: the calendar is shared with the service account in GOOGLE_SERVICE_ACCOUNT_KEY
  // calendars: [{ id, label, busy, block: { busy, free, allDay } }] – busy: true closes online booking when that
  // calendar has events; block says which kinds count (timed events marked Busy or Free, and all-day events).
  // bookingCalendar: the calendar ID new bookings are added to ('' for none).
  google: { calendars: [], bookingCalendar: '', detail: 'minimal' },
  // Apple Calendar: read with the APPLE_ID and APPLE_APP_PASSWORD secrets. calendars: [{ url, label, busy, block }]
  // like Google's, with the calendar's iCloud address as url; bookingCalendar: the url new bookings are added to.
  apple: { calendars: [], bookingCalendar: '' },
};

// ---------- small helpers ----------
// Patient-facing messages in Chinese (the API gets the page language in the x-lang header)
const ZH = {
  'Please choose a visit type.': '请选择就诊类型。',
  'Please choose a date and time.': '请选择日期和时间。',
  'Please choose in person or telemedicine.': '请选择到诊或远程视频就诊。',
  'Please enter your name.': '请填写您的姓名。',
  'Please enter a phone number we can reach you at.': '请填写可以联系到您的电话号码。',
  'Please check your email address.': '请检查您的电子邮箱地址。',
  'Please enter your email address.': '请填写您的电子邮箱地址。',
  'Sorry, that time was just taken. Please choose another.': '抱歉，这个时间刚刚被预约了，请选择其他时间。',
  'Please confirm the consent box to book.': '请勾选同意框后再预约。',
  'Too many bookings from this connection. Please call or text us.': '此网络的预约次数过多，请致电或发短信联系我们。',
  'Booking not found.': '找不到该预约。',
  'This booking could not be cancelled. Please call or text us.': '无法取消该预约，请致电或发短信联系我们。',
  'Something went wrong. Please try again, or call or text us.': '出了点问题，请重试，或致电、发短信联系我们。',
  'Please enter an email address or phone number so we can reply.': '请填写电子邮箱或电话号码，以便我们回复您。',
  'Please write a message.': '请填写留言内容。',
  'Please confirm the consent box to send your message.': '请勾选同意框后再发送留言。',
  'Too many messages from this connection. Please call or text us.': '此网络发送的留言过多，请致电或发短信联系我们。',
};
const tr = (lang, msg) => (String(lang || '').startsWith('zh') && ZH[msg]) || msg;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const dayNum = (date) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const dateOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const weekday = (date) => new Date(dayNum(date) * 864e5).getUTCDay();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayNum(s));
const isHM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// Clinic wall-clock time (date and minutes after midnight) for a moment in time
function laParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
const nowLA = () => laParts(Date.now());
const absMin = (date, min) => dayNum(date) * 1440 + min; // minutes since 1970 on the clinic's wall clock

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
      name_zh: String(t.name_zh || '').trim().slice(0, 80),
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
  if (Array.isArray(input.blockedTimes)) {
    const seen = new Set();
    s.blockedTimes = input.blockedTimes
      .filter((b) => b && isDate(b.date) && isHM(b.start) && isHM(b.end) && hm(b.end) > hm(b.start))
      .map((b) => ({ date: b.date, start: b.start, end: b.end }))
      .filter((b) => { const k = `${b.date} ${b.start} ${b.end}`; return !seen.has(k) && seen.add(k); })
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .slice(-2000);
  }
  if (input.google && typeof input.google === 'object') {
    const g = input.google;
    const okId = (v) => { const id = String(v || '').trim().slice(0, 300); return /^[^\s"'<>]+$/.test(id) ? id : ''; };
    // Settings saved before multiple calendars had a single calendarId
    let cals = Array.isArray(g.calendars) ? g.calendars : g.calendarId ? [{ id: g.calendarId, label: '', busy: g.blockBusy === true }] : [];
    const seen = new Set();
    cals = cals.slice(0, 10)
      .map((c) => {
        const k = (c && c.block) || {};
        return { id: okId(c && c.id), label: String((c && c.label) || '').trim().slice(0, 60), busy: !!(c && c.busy), block: { busy: k.busy !== false, free: k.free !== false, allDay: k.allDay !== false } };
      })
      .filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));
    let booking = 'bookingCalendar' in g ? okId(g.bookingCalendar) : g.calendarId && g.addEvents !== false ? okId(g.calendarId) : '';
    if (!cals.some((c) => c.id === booking)) booking = '';
    s.google = { calendars: cals, bookingCalendar: booking, detail: g.detail === 'full' ? 'full' : 'minimal' };
  }
  if (input.apple && typeof input.apple === 'object') {
    const a = input.apple;
    const okUrl = (v) => { const u = String(v || '').trim().slice(0, 500); return /^https?:\/\/[^\s"'<>]+$/.test(u) ? u : ''; };
    const seen = new Set();
    const cals = (Array.isArray(a.calendars) ? a.calendars : []).slice(0, 20)
      .map((c) => {
        const k = (c && c.block) || {};
        return { url: okUrl(c && c.url), label: String((c && c.label) || '').trim().slice(0, 60), busy: !!(c && c.busy), block: { busy: k.busy !== false, free: k.free !== false, allDay: k.allDay !== false } };
      })
      .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
    const booking = okUrl(a.bookingCalendar);
    s.apple = { calendars: cals, bookingCalendar: cals.some((c) => c.url === booking) ? booking : '' };
  }
  return s;
}

// ---------- Google Calendar ----------
// The GOOGLE_SERVICE_ACCOUNT_KEY secret holds the service account's JSON key file. The doctor shares their
// calendar with the service account's email ("Make changes to events") and enters the calendar ID in the admin.
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
let googleToken = null; // { value, exp, email } cached per isolate

function serviceAccount(env) {
  try {
    const k = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY || '');
    return k.client_email && k.private_key ? k : null;
  } catch {
    return null;
  }
}

async function googleAccessToken(env) {
  const sa = serviceAccount(env);
  if (!sa) throw new Error('The Google service account key has not been added to Cloudflare yet (secret GOOGLE_SERVICE_ACCOUNT_KEY).');
  if (googleToken && googleToken.email === sa.client_email && googleToken.exp > Date.now() + 60e3) return googleToken.value;
  const tokenUrl = env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN;
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(`Google rejected the service account key (${d.error_description || d.error || res.status}).`);
  googleToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, email: sa.client_email };
  return d.access_token;
}

async function gcal(env, method, path, body) {
  const res = await fetch((env.GOOGLE_API_BASE || GOOGLE_API) + path, {
    method,
    headers: { authorization: `Bearer ${await googleAccessToken(env)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'DELETE' && [204, 404, 410].includes(res.status)) return {}; // deleted, or already gone
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((d.error && d.error.message) || `Google Calendar error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return d;
}

const calPath = (id) => `/calendars/${encodeURIComponent(id)}`;
const localIso = (abs) => `${dateOf(Math.floor(abs / 1440))}T${String(Math.floor((abs % 1440) / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}:00`;

// The calendar event for a booking. "minimal" keeps patient contact details out of Google.
function eventFor(b, detail, origin) {
  const mode = b.mode === 'telemedicine' ? 'Telemedicine' : 'In person';
  const initials = b.name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join('');
  const full = detail === 'full';
  const lines = full
    ? [`Patient: ${b.name}`, `Phone: ${b.phone}`, b.email && `Email: ${b.email}`, `Visit: ${mode}`, b.note && `Note: ${b.note}`]
    : [`Patient: ${initials}`, `Visit: ${mode}`, 'Full details are in the admin, not in the calendar.'];
  const start = absMin(b.date, b.start);
  return {
    summary: `${b.type_name} – ${full ? b.name : initials} (${mode})`,
    description: [...lines, '', `Booked through the EternaWell website. Admin: ${origin}/admin/`].filter((l) => l !== false && l !== undefined && l !== '').join('\n'),
    start: { dateTime: localIso(start), timeZone: TZ },
    end: { dateTime: localIso(start + b.minutes), timeZone: TZ },
    location: b.mode === 'telemedicine' ? 'Telemedicine' : undefined,
    extendedProperties: { private: { eternawellBooking: b.id } },
    reminders: { useDefault: true },
  };
}

// ---------- Apple Calendar (iCloud, over CalDAV) ----------
// The APPLE_ID secret is the doctor's Apple ID email and APPLE_APP_PASSWORD an app-specific password made at
// appleid.apple.com. They are only ever sent to iCloud (APPLE_CALDAV_URL exists only for local testing).
const APPLE_CALDAV = 'https://caldav.icloud.com/';

function appleAccount(env) {
  const id = String(env.APPLE_ID || '').trim();
  const pass = String(env.APPLE_APP_PASSWORD || '').trim();
  return id && pass ? { id, pass } : null;
}

function appleHostOk(env, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' && (u.hostname === 'icloud.com' || u.hostname.endsWith('.icloud.com'))) return true;
  return !!env.APPLE_CALDAV_URL && u.origin === new URL(env.APPLE_CALDAV_URL).origin;
}

// One CalDAV request. Follows iCloud's redirects to the server that holds the account.
async function dav(env, method, url, body, headers = {}) {
  const acct = appleAccount(env);
  if (!acct) throw new Error('The Apple ID and app-specific password have not been added to Cloudflare yet (secrets APPLE_ID and APPLE_APP_PASSWORD).');
  const auth = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${acct.id}:${acct.pass}`)))}`;
  for (let hop = 0; hop < 4; hop++) {
    if (!appleHostOk(env, url)) throw new Error("That isn't an iCloud calendar address.");
    const res = await fetch(url, { method, redirect: 'manual', body, headers: { authorization: auth, ...headers } });
    const to = res.headers.get('location');
    if ([301, 302, 307, 308].includes(res.status) && to) { url = new URL(to, url).href; continue; }
    if (res.status === 401) { const e = new Error('iCloud rejected the Apple ID or app-specific password. Make a new app-specific password and update the APPLE_APP_PASSWORD secret.'); e.status = 401; throw e; }
    if (method === 'DELETE' && [200, 204, 404, 410].includes(res.status)) return { text: '', url };
    const text = await res.text();
    if (!res.ok) { const e = new Error(`iCloud error ${res.status}`); e.status = res.status; throw e; }
    return { text, url };
  }
  throw new Error('iCloud redirected too many times.');
}

const XML = { 'content-type': 'application/xml; charset=utf-8' };
const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
const propfind = (env, url, depth, props) => dav(env, 'PROPFIND', url, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NS}><d:prop>${props}</d:prop></d:propfind>`, { ...XML, depth: String(depth) });

// A small reader for CalDAV's XML replies: the <response> blocks, and the text of a tag inside one
// (whatever namespace prefix the server uses).
const xmlText = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlBlocks = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'gi'))].map((m) => m[1] || '');
const xmlTag = (xml, tag) => { const b = xmlBlocks(xml, tag); return b.length ? xmlText(b[0]).trim() : ''; };

// Clinic-independent time-zone maths for calendar files: wall-clock time in a zone <-> a moment in time
const zoneFormats = new Map();
function zoneOffset(ms, tz) {
  let f = zoneFormats.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }); } catch { f = null; }
    zoneFormats.set(tz, f);
  }
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function zonedMs(wall, tz) { // wall: the wall-clock time written as if it were UTC
  if (zoneOffset(0, tz) === null) tz = TZ; // unknown zone names (e.g. from Outlook) count as clinic time
  let t = wall - zoneOffset(wall, tz);
  t = wall - zoneOffset(t, tz);
  return t;
}

// ---- calendar files (iCalendar, RFC 5545) ----
function icsProps(block) {
  return block.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.search(/[:;]/);
    if (i < 0) return null;
    const name = line.slice(0, i).toUpperCase();
    const params = {};
    let rest = line.slice(i);
    while (rest[0] === ';') {
      const m = rest.match(/^;([^=;:]+)=("[^"]*"|[^;:]*)/);
      if (!m) break;
      params[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
      rest = rest.slice(m[0].length);
    }
    return { name, params, value: rest.slice(1) };
  }).filter(Boolean);
}

// A DTSTART/DTEND value as { date } (all day) or { wall, tz } (wall-clock ms in a zone; tz '' = UTC)
function icsTime(p) {
  if (!p) return null;
  const m = p.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (!m[4] || p.params.VALUE === 'DATE') return { date: `${m[1]}-${m[2]}-${m[3]}` };
  return { wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), tz: m[7] ? '' : p.params.TZID || TZ };
}
const icsMs = (t) => (t.tz ? zonedMs(t.wall, t.tz) : t.wall);
function icsDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 7 * 864e5 + (+m[3] || 0) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}

// The events in a calendar-query reply, with repeating events expanded between two moments, as
// { start, end, kind } where start/end are clinic minute ranges like the Google ones.
function icsEvents(text, fromMs, toMs, me) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const vevents = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)].map((m) => {
    const props = icsProps(m[1]);
    const one = (n) => props.find((p) => p.name === n);
    return { props, one, uid: (one('UID') || {}).value || '', rid: icsTime(one('RECURRENCE-ID')) };
  });
  const key = (t) => (t.date ? t.date : String(icsMs(t)));
  const overridden = new Set(vevents.filter((v) => v.rid).map((v) => `${v.uid}|${key(v.rid)}`));
  const out = [];
  for (const v of vevents) {
    if (/^CANCELLED$/i.test((v.one('STATUS') || {}).value || '')) continue;
    const attendee = me && v.props.find((p) => p.name === 'ATTENDEE' && p.value.toLowerCase() === `mailto:${me.toLowerCase()}`);
    if (attendee && attendee.params.PARTSTAT === 'DECLINED') continue;
    const start = icsTime(v.one('DTSTART'));
    if (!start) continue;
    const end = icsTime(v.one('DTEND'));
    const kind = start.date ? 'allDay' : /^TRANSPARENT$/i.test((v.one('TRANSP') || {}).value || '') ? 'free' : 'busy';
    // length of the event: whole days for all-day events, milliseconds otherwise
    const len = start.date
      ? (end && end.date ? dayNum(end.date) - dayNum(start.date) : Math.max(1, Math.round(icsDuration((v.one('DURATION') || {}).value) / 864e5) || 1))
      : (end && !end.date ? icsMs(end) - icsMs(start) : icsDuration((v.one('DURATION') || {}).value));
    if (len <= 0) continue;
    const rrule = v.rid ? null : v.one('RRULE');
    const skip = new Set();
    for (const p of v.props.filter((x) => x.name === 'EXDATE')) {
      for (const val of p.value.split(',')) { const t = icsTime({ value: val, params: p.params }); if (t) skip.add(key(start.date && !t.date ? { date: dateOf(Math.floor(t.wall / 864e5)) } : t)); }
    }
    const starts = rrule ? icsRepeat(start, rrule.value, toMs) : [start];
    for (const s of starts) {
      if (rrule && (skip.has(key(s)) || overridden.has(`${v.uid}|${key(s)}`))) continue;
      let a, b;
      if (s.date) { a = absMin(s.date, 0); b = a + len * 1440; } else {
        const ms = icsMs(s);
        const pa = laParts(ms), pb = laParts(ms + len);
        a = absMin(pa.date, pa.min); b = absMin(pb.date, pb.min);
      }
      const aMs = s.date ? zonedMs(dayNum(s.date) * 864e5, TZ) : icsMs(s);
      if (aMs >= toMs || aMs + (s.date ? len * 864e5 : len) <= fromMs) continue;
      out.push({ start: a, end: b, kind });
    }
  }
  return out;
}

// The start times of a repeating event up to a moment, for the common rules (daily, weekly, monthly,
// yearly, with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY and BYMONTH). iCloud normally expands repeats
// itself, so this is only a fallback.
function icsRepeat(start, rule, toMs) {
  const r = Object.fromEntries(rule.split(';').map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v || '']));
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start];
  const every = Math.max(1, +r.INTERVAL || 1);
  const count = +r.COUNT || Infinity;
  const until = r.UNTIL ? icsTime({ value: r.UNTIL, params: {} }) : null;
  const untilMs = until ? (until.date ? zonedMs((dayNum(until.date) + 1) * 864e5, TZ) - 1 : icsMs(until)) : Infinity;
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const byDay = (r.BYDAY || '').split(',').filter(Boolean).map((x) => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m && { n: +m[1] || 0, wd: DAYS.indexOf(m[2].toUpperCase()) }; }).filter(Boolean);
  const byMonthDay = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const byMonth = (r.BYMONTH || '').split(',').filter(Boolean).map(Number);
  const d0 = start.date ? dayNum(start.date) : Math.floor(start.wall / 864e5);
  const tod = start.date ? 0 : start.wall - d0 * 864e5;
  const day0 = new Date(d0 * 864e5);
  const wkst = DAYS.indexOf((r.WKST || 'MO').toUpperCase());
  const weekOf = (d) => Math.floor((d - ((new Date(d * 864e5).getUTCDay() - wkst + 7) % 7) - d0 + ((day0.getUTCDay() - wkst + 7) % 7)) / 7);
  const matches = (d) => {
    const dt = new Date(d * 864e5);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth(), md = dt.getUTCDate(), wd = dt.getUTCDay();
    const months = (y - day0.getUTCFullYear()) * 12 + mo - day0.getUTCMonth();
    const inMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const nth = (b) => b.wd === wd && (!b.n || (b.n > 0 ? Math.ceil(md / 7) === b.n : Math.ceil((inMonth - md + 1) / 7) === -b.n));
    if (byMonth.length && !byMonth.includes(mo + 1)) return false;
    if (freq === 'DAILY') return (d - d0) % every === 0 && (!byDay.length || byDay.some((b) => b.wd === wd));
    if (freq === 'WEEKLY') return weekOf(d) % every === 0 && (byDay.length ? byDay.some((b) => b.wd === wd) : wd === day0.getUTCDay());
    if (freq === 'MONTHLY') {
      if (months % every) return false;
      if (byDay.length) return byDay.some(nth);
      if (byMonthDay.length) return byMonthDay.some((x) => (x > 0 ? x : inMonth + x + 1) === md);
      return md === day0.getUTCDate();
    }
    if ((y - day0.getUTCFullYear()) % every) return false;
    if (byDay.length && byMonth.length) return byDay.some(nth);
    return mo === day0.getUTCMonth() && md === day0.getUTCDate();
  };
  const out = [];
  let n = 0;
  for (let d = d0; d < d0 + 40000 && n < count; d++) {
    const s = start.date ? { date: dateOf(d) } : { wall: d * 864e5 + tod, tz: start.tz };
    const ms = start.date ? zonedMs(d * 864e5, TZ) : icsMs(s);
    if (ms > untilMs || ms >= toMs) break;
    if (d !== d0 && !matches(d)) continue;
    n++;
    out.push(s);
  }
  return out;
}

// A booking as a calendar file for iCloud (times in UTC, so no time-zone block is needed). Apple doesn't
// sign HIPAA agreements, so these events always use the minimal details.
function icsFor(b, origin) {
  const ev = eventFor(b, 'minimal', origin);
  const start = absMin(b.date, b.start);
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line) => { // lines of at most 75 bytes
    let out = '', len = 0;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (len + n > 74) { out += '\r\n '; len = 1; }
      out += ch; len += n;
    }
    return out;
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EternaWell Medicine//Booking//EN', 'BEGIN:VEVENT',
    `UID:eternawell-${b.id}@eternawell`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(zonedMs(start * 6e4, TZ))}`, `DTEND:${stamp(zonedMs((start + b.minutes) * 6e4, TZ))}`,
    `SUMMARY:${esc(ev.summary)}`, `DESCRIPTION:${esc(ev.description)}`, ev.location && `LOCATION:${esc(ev.location)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== undefined).map(fold).join('\r\n');
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
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL, message TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'en', page TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, t INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hits_k ON hits(k, t);`);
    // Google Calendar event for each booking, and which calendar it is on
    const cols = this.sql.exec('PRAGMA table_info(bookings)').toArray().map((c) => c.name);
    if (!cols.includes('gcal_id')) this.sql.exec("ALTER TABLE bookings ADD COLUMN gcal_id TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('gcal_cal')) this.sql.exec("ALTER TABLE bookings ADD COLUMN gcal_cal TEXT NOT NULL DEFAULT ''");
    // the booking's event on an Apple calendar: its address, and the calendar's
    if (!cols.includes('apple_href')) this.sql.exec("ALTER TABLE bookings ADD COLUMN apple_href TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('apple_cal')) this.sql.exec("ALTER TABLE bookings ADD COLUMN apple_cal TEXT NOT NULL DEFAULT ''");
    this.busyCache = new Map(); // "from|to" -> { at, ranges }
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

  slots(settings, type, date, taken, calBusy = []) {
    if (!isDate(date)) return [];
    const h = settings.hours[weekday(date)];
    if (!h || settings.blockedDates.includes(date)) return [];
    const now = nowLA();
    const today = dayNum(now.date);
    const d = dayNum(date);
    if (d < today || d > today + settings.maxDaysAhead) return [];
    const earliest = today * 1440 + now.min + settings.minNoticeHours * 60;
    const busy = taken.filter((b) => b.date === date)
      .map((b) => [absMin(b.date, b.start) - settings.bufferMinutes, absMin(b.date, b.start) + b.minutes + settings.bufferMinutes])
      .concat(settings.blockedTimes.filter((b) => b.date === date).map((b) => [absMin(date, hm(b.start)), absMin(date, hm(b.end))]))
      .concat(calBusy);
    const out = [];
    for (let t = hm(h.start); t + type.minutes <= hm(h.end); t += settings.slotStep) {
      const at = d * 1440 + t;
      if (at < earliest) continue;
      if (busy.some(([a, b]) => at < b && at + type.minutes > a)) continue;
      out.push(t);
    }
    return out;
  }

  // ---- calendars ----
  // Last result of talking to Google ('google') or iCloud ('apple'), shown in the admin
  calState(which) {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', `${which}_status`).toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  noteCal(which, ok, message) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', `${which}_status`, JSON.stringify({ ok, message: String(message || '').slice(0, 300), at: Date.now() }));
  }

  googleState() { return this.calState('google'); }
  noteGoogle(ok, message) { this.noteCal('google', ok, message); }

  // Busy times on every connected calendar, Google and Apple: [start, end, calendar name, 'google' | 'apple']
  async calendarBusy(settings, from, to, fresh = false) {
    const [g, a] = await Promise.all([this.googleBusy(settings, from, to, fresh), this.appleBusy(settings, from, to, fresh)]);
    return g.map((r) => [...r, 'google']).concat(a.map((r) => [...r, 'apple']));
  }

  // Times taken up on the connected calendars between two dates, as wall-clock minute ranges
  // [start, end, calendar name]. Every event counts, whether it's marked Busy or Free in Google, and all-day
  // events block the whole day; cancelled events and ones the doctor declined don't. Cached for a minute.
  async googleBusy(settings, from, to, fresh = false) {
    const cals = settings.google.calendars.filter((c) => c.busy);
    if (!cals.length || !serviceAccount(this.env)) return [];
    const key = `${cals.map((c) => `${c.id}:${+c.block.busy}${+c.block.free}${+c.block.allDay}`).join(',')}|${from}|${to}`;
    const hit = this.busyCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.ranges;
    // a day either side covers the time-zone offset; ranges are filtered by date in slots()
    const timeMin = new Date((dayNum(from) - 1) * 864e5).toISOString();
    const timeMax = new Date((dayNum(to) + 2) * 864e5).toISOString();
    const failed = [];
    const results = await Promise.all(cals.map((c) => this.calendarRanges(c, timeMin, timeMax).catch((err) => {
      failed.push(`${c.label || c.id} (${err.status === 404 ? 'notFound' : err.message})`);
      return null;
    })));
    if (failed.length) this.noteGoogle(false, `Google can't read busy times for: ${failed.join(', ')}. Check each calendar is shared with the service account.`);
    if (results.every((r) => r === null) && hit) return hit.ranges; // if Google is unreachable, keep what we had
    const ranges = [].concat(...results.filter(Boolean));
    this.busyCache.set(key, { at: Date.now(), ranges });
    if (this.busyCache.size > 50) this.busyCache.delete(this.busyCache.keys().next().value);
    return ranges;
  }

  // One calendar's events as minute ranges, keeping only the kinds chosen in c.block. Falls back to Google's
  // free/busy lookup (Busy events only) when the calendar is shared as "See only free/busy".
  async calendarRanges(c, timeMin, timeMax) {
    const name = c.label || c.id;
    const toRange = (start, end) => {
      if (start.date) return [absMin(start.date, 0), absMin(end.date || start.date, 0) + (end.date ? 0 : 1440), name]; // all-day: whole days
      const a = laParts(Date.parse(start.dateTime));
      const b = laParts(Date.parse(end.dateTime));
      return [absMin(a.date, a.min), absMin(b.date, b.min), name];
    };
    try {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '2500', fields: 'nextPageToken,items(status,transparency,start,end,attendees(self,responseStatus))' });
        if (pageToken) q.set('pageToken', pageToken);
        const d = await gcal(this.env, 'GET', `${calPath(c.id)}/events?${q}`);
        for (const ev of d.items || []) {
          if (ev.status === 'cancelled' || !ev.start || !ev.end) continue;
          const me = (ev.attendees || []).find((x) => x.self);
          if (me && me.responseStatus === 'declined') continue;
          const kind = ev.start.date ? 'allDay' : ev.transparency === 'transparent' ? 'free' : 'busy';
          if (!c.block[kind]) continue;
          out.push(toRange(ev.start, ev.end));
        }
        if (!d.nextPageToken) break;
        pageToken = d.nextPageToken;
      }
      return out;
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      const d = await gcal(this.env, 'POST', '/freeBusy', { timeMin, timeMax, timeZone: TZ, items: [{ id: c.id }] });
      const cal = (d.calendars || {})[c.id] || {};
      if (cal.errors && cal.errors.length) { const e = new Error(cal.errors[0].reason); e.status = cal.errors[0].reason === 'notFound' ? 404 : 403; throw e; }
      return c.block.busy ? (cal.busy || []).map((x) => toRange({ dateTime: x.start }, { dateTime: x.end })) : [];
    }
  }

  // The same for the Apple calendars chosen to block booking, read from iCloud
  async appleBusy(settings, from, to, fresh = false) {
    const cals = settings.apple.calendars.filter((c) => c.busy);
    if (!cals.length || !appleAccount(this.env)) return [];
    const key = `apple|${cals.map((c) => `${c.url}:${+c.block.busy}${+c.block.free}${+c.block.allDay}`).join(',')}|${from}|${to}`;
    const hit = this.busyCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.ranges;
    const fromMs = (dayNum(from) - 1) * 864e5;
    const toMs = (dayNum(to) + 2) * 864e5;
    const failed = [];
    const results = await Promise.all(cals.map((c) => this.appleRanges(c, fromMs, toMs).catch((err) => {
      failed.push(`${c.label || 'Apple calendar'} (${err.message})`);
      return null;
    })));
    if (failed.length) this.noteCal('apple', false, `iCloud can't read busy times for: ${failed.join(', ')}.`);
    if (results.every((r) => r === null) && hit) return hit.ranges; // if iCloud is unreachable, keep what we had
    const ranges = [].concat(...results.filter(Boolean));
    this.busyCache.set(key, { at: Date.now(), ranges });
    if (this.busyCache.size > 50) this.busyCache.delete(this.busyCache.keys().next().value);
    return ranges;
  }

  async appleRanges(c, fromMs, toMs) {
    const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV_NS}><d:prop><c:calendar-data><c:expand start="${t(fromMs)}" end="${t(toMs)}"/></c:calendar-data></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(fromMs)}" end="${t(toMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await dav(this.env, 'REPORT', c.url, body, { ...XML, depth: '1' });
    const me = appleAccount(this.env).id;
    const name = c.label || 'Apple calendar';
    return [].concat(...xmlBlocks(r.text, 'calendar-data').map((x) => icsEvents(xmlText(x), fromMs, toMs, me)))
      .filter((e) => c.block[e.kind])
      .map((e) => [e.start, e.end, name]);
  }

  // The doctor's iCloud calendars (that hold events), for the admin to choose from
  async appleCalendars() {
    const acct = appleAccount(this.env);
    if (!acct) return { ok: false, message: 'The Apple ID and app-specific password have not been added to Cloudflare yet (secrets APPLE_ID and APPLE_APP_PASSWORD).' };
    try {
      const row = this.sql.exec("SELECT v FROM kv WHERE k = 'apple_home'").toArray()[0];
      const saved = row ? JSON.parse(row.v) : null;
      let home = saved && saved.id === acct.id ? saved.url : '';
      let r;
      if (home) r = await propfind(this.env, home, 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/>').catch((err) => { if (err.status === 401) throw err; return null; });
      if (!r) {
        const base = this.env.APPLE_CALDAV_URL || APPLE_CALDAV;
        const p1 = await propfind(this.env, base, 0, '<d:current-user-principal/>');
        const principal = xmlTag(xmlBlocks(p1.text, 'current-user-principal')[0] || '', 'href');
        if (!principal) throw new Error("iCloud didn't say where this account's calendars are.");
        const p2 = await propfind(this.env, new URL(principal, p1.url).href, 0, '<c:calendar-home-set/>');
        const homeHref = xmlTag(xmlBlocks(p2.text, 'calendar-home-set')[0] || '', 'href');
        if (!homeHref) throw new Error("iCloud didn't say where this account's calendars are.");
        home = new URL(homeHref, p2.url).href;
        this.sql.exec("INSERT INTO kv (k, v) VALUES ('apple_home', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify({ id: acct.id, url: home }));
        r = await propfind(this.env, home, 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/>');
      }
      const calendars = xmlBlocks(r.text, 'response').map((x) => {
        const type = xmlBlocks(x, 'resourcetype')[0] || '';
        const comps = xmlBlocks(x, 'supported-calendar-component-set')[0];
        if (!/<(?:[\w-]+:)?calendar(?=[\s/>])/i.test(type)) return null;
        if (comps !== undefined && /comp\b/i.test(comps) && !/name="VEVENT"/i.test(comps)) return null; // reminders lists
        return { url: new URL(xmlTag(x, 'href'), r.url).href, name: xmlTag(x, 'displayname') || 'Calendar', color: (xmlTag(x, 'calendar-color').match(/^#[0-9a-f]{6}/i) || [''])[0] };
      }).filter(Boolean);
      this.noteCal('apple', true, calendars.length ? 'Connected to iCloud.' : 'Connected, but there are no calendars in this iCloud account.');
      return { ok: true, calendars };
    } catch (err) {
      this.noteCal('apple', false, err.message);
      return { ok: false, message: err.message };
    }
  }

  // Adds, or (when status isn't confirmed) removes, a booking's calendar events. Never throws.
  async syncEvent(id, origin) {
    const b = this.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
    if (!b) return;
    const s = this.getSettings();
    await this.syncGoogle(b, s.google, origin);
    await this.syncApple(b, s.apple, origin);
  }

  async syncApple(b, a, origin) {
    if (!appleAccount(this.env) || (!a.bookingCalendar && !b.apple_href)) return;
    try {
      const wanted = b.status !== 'cancelled' && a.bookingCalendar;
      if (b.apple_href && (!wanted || b.apple_cal !== a.bookingCalendar)) {
        await dav(this.env, 'DELETE', b.apple_href);
        this.sql.exec("UPDATE bookings SET apple_href = '', apple_cal = '' WHERE id = ?", b.id);
        b.apple_href = '';
      }
      if (wanted && !b.apple_href) {
        const href = new URL(`eternawell-${b.id}.ics`, a.bookingCalendar.replace(/\/?$/, '/')).href;
        await dav(this.env, 'PUT', href, icsFor(b, origin), { 'content-type': 'text/calendar; charset=utf-8' });
        this.sql.exec('UPDATE bookings SET apple_href = ?, apple_cal = ? WHERE id = ?', href, a.bookingCalendar, b.id);
      }
      this.busyCache.clear();
      this.noteCal('apple', true, 'Last calendar update worked.');
    } catch (err) {
      this.noteCal('apple', false, err.status === 403 || err.status === 404
        ? `iCloud refused the update (${err.message}). Check the calendar still exists and isn't read-only.`
        : err.message);
    }
  }

  async syncGoogle(b, g, origin) {
    const id = b.id;
    if (!serviceAccount(this.env)) return;
    try {
      const wanted = b.status !== 'cancelled' && g.bookingCalendar;
      if (b.gcal_id && (!wanted || b.gcal_cal !== g.bookingCalendar)) {
        await gcal(this.env, 'DELETE', `${calPath(b.gcal_cal)}/events/${encodeURIComponent(b.gcal_id)}`);
        this.sql.exec("UPDATE bookings SET gcal_id = '', gcal_cal = '' WHERE id = ?", id);
        b.gcal_id = '';
      }
      if (wanted && !b.gcal_id) {
        const ev = await gcal(this.env, 'POST', `${calPath(g.bookingCalendar)}/events`, eventFor(b, g.detail, origin));
        this.sql.exec('UPDATE bookings SET gcal_id = ?, gcal_cal = ? WHERE id = ?', ev.id || '', g.bookingCalendar, id);
      }
      this.busyCache.clear(); // the calendar changed
      this.noteGoogle(true, 'Last calendar update worked.');
    } catch (err) {
      this.noteGoogle(false, err.status === 404 || err.status === 403
        ? `Google Calendar refused the update (${err.message}). Check the calendar ID, and that the calendar is shared with the service account with "Make changes to events".`
        : err.message);
    }
  }

  // Puts every upcoming confirmed booking on the current calendar (after connecting or changing calendars).
  async syncUpcoming(origin) {
    const ids = this.sql.exec("SELECT id FROM bookings WHERE date >= ? AND status = 'confirmed'", nowLA().date).toArray().map((r) => r.id);
    for (const id of ids) await this.syncEvent(id, origin);
    return { count: ids.length, status: this.googleState(), apple: this.calState('apple') };
  }

  // Checks the key and the calendar sharing, for the admin's "Test connection" button.
  async testGoogle(calendarId) {
    const sa = serviceAccount(this.env);
    if (!sa) return { ok: false, message: 'The service account key has not been added to Cloudflare yet.' };
    if (!calendarId) return { ok: false, message: 'Enter the calendar ID first.' };
    try {
      const cal = await gcal(this.env, 'GET', calPath(calendarId));
      const roles = await gcal(this.env, 'GET', `/users/me/calendarList/${encodeURIComponent(calendarId)}`).catch(() => null);
      if (roles && roles.accessRole && !['writer', 'owner'].includes(roles.accessRole)) {
        return { ok: false, message: `Connected to "${cal.summary}", but it's shared as "${roles.accessRole}". Change the sharing permission to "Make changes to events".` };
      }
      return { ok: true, message: `Connected to "${cal.summary}". Bookings can now be added to this calendar.` };
    } catch (err) {
      if (err.status === 404) return { ok: false, message: `Google can't find that calendar. Check the calendar ID, and that the calendar is shared with ${sa.client_email}.` };
      return { ok: false, message: err.message };
    }
  }

  publicInfo() {
    const s = this.getSettings();
    return { visitTypes: s.visitTypes.filter((t) => t.active).map(({ id, name, name_zh, minutes }) => ({ id, name, name_zh, minutes })), maxDaysAhead: s.maxDaysAhead, today: nowLA().date, clinic: s.clinic };
  }

  async availableDates(typeId, month) {
    const s = this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !/^\d{4}-\d{2}$/.test(month)) return [];
    const first = dayNum(`${month}-01`);
    const [y, m] = month.split('-').map(Number);
    const last = Date.UTC(y, m, 0) / 864e5;
    const calBusy = await this.calendarBusy(s, dateOf(first), dateOf(last));
    const taken = this.takenOn(dateOf(first), dateOf(last));
    const out = [];
    for (let d = first; d <= last; d++) if (this.slots(s, type, dateOf(d), taken, calBusy).length) out.push(dateOf(d));
    return out;
  }

  async availableTimes(typeId, date) {
    const s = this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !isDate(date)) return [];
    const calBusy = await this.calendarBusy(s, date, date);
    return this.slots(s, type, date, this.takenOn(date, date), calBusy);
  }

  // Creates a booking. Online bookings must fit an open slot; the admin can add any time.
  async createBooking(b, { admin = false, origin = '' } = {}) {
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
    if (!admin) {
      const calBusy = await this.calendarBusy(s, b.date, b.date, true);
      // no await between this check and the insert below, so two people can't take the same time
      if (!this.slots(s, type, b.date, this.takenOn(b.date, b.date), calBusy).includes(b.start)) return { error: 'Sorry, that time was just taken. Please choose another.' };
    }
    const row = {
      id: randomHex(8), token: randomHex(16), date: b.date, start: b.start, minutes: type.minutes, type: type.id, type_name: type.name,
      mode: b.mode, name, phone, email, status: 'confirmed', note: String(b.note || '').slice(0, 1000), source: admin ? 'admin' : 'online', created: Date.now(),
    };
    this.sql.exec('INSERT INTO bookings (id, token, date, start, minutes, type, type_name, mode, name, phone, email, status, note, source, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...Object.values(row));
    await this.syncEvent(row.id, origin);
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

  async updateBooking(id, patch, origin = '') {
    const row = this.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    const status = ['confirmed', 'completed', 'cancelled'].includes(patch.status) ? patch.status : row.status;
    const note = typeof patch.note === 'string' ? patch.note.slice(0, 1000) : row.note;
    this.sql.exec('UPDATE bookings SET status = ?, note = ? WHERE id = ?', status, note, id);
    if (status !== row.status) await this.syncEvent(id, origin);
    return { ...row, status, note };
  }

  async deleteBooking(id) {
    this.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", id);
    await this.syncEvent(id); // removes the calendar event first
    this.sql.exec('DELETE FROM bookings WHERE id = ?', id);
    return true;
  }

  // Everything for the admin's week calendar: bookings, blocked days and hours, weekly hours, calendar busy times
  async schedule(from, to) {
    if (!isDate(from) || !isDate(to) || dayNum(to) < dayNum(from) || dayNum(to) - dayNum(from) > 62) return null;
    const s = this.getSettings();
    const bookings = this.sql.exec("SELECT id, date, start, minutes, type, type_name, mode, name, phone, email, status, source FROM bookings WHERE date >= ? AND date <= ? AND status IN ('confirmed', 'completed') ORDER BY date, start", from, to).toArray();
    const google = [];
    for (const [a, b, label, src] of await this.calendarBusy(s, from, to, true)) { // always fresh in the admin
      // split ranges that cross midnight into one piece per day
      for (let d = Math.floor(a / 1440); d * 1440 < b; d++) {
        const date = dateOf(d);
        if (date < from || date > to) continue;
        google.push({ date, start: Math.max(a, d * 1440) - d * 1440, end: Math.min(b, (d + 1) * 1440) - d * 1440, label, src });
      }
    }
    return { bookings, blockedDates: s.blockedDates, blockedTimes: s.blockedTimes, hours: s.hours, google, today: nowLA().date };
  }

  // Adds or removes blocked time. Items are { date, allDay: true } or { date, start: 'HH:MM', end: 'HH:MM' }.
  updateBlocks(add, remove) {
    const s = this.getSettings();
    const same = (x, y) => x.date === y.date && x.start === y.start && x.end === y.end;
    for (const r of remove || []) {
      if (!r || !isDate(r.date)) continue;
      if (r.allDay) s.blockedDates = s.blockedDates.filter((d) => d !== r.date);
      else s.blockedTimes = s.blockedTimes.filter((b) => !same(b, r));
    }
    for (const a of add || []) {
      if (!a || !isDate(a.date)) continue;
      if (a.allDay) s.blockedDates.push(a.date);
      else s.blockedTimes.push({ date: a.date, start: a.start, end: a.end });
    }
    const saved = this.saveSettings(s); // validates, removes duplicates and sorts
    return { blockedDates: saved.blockedDates, blockedTimes: saved.blockedTimes };
  }

  // Messages from the website's "Send the doctor a message" form
  addMessage(m) {
    const name = String(m.name || '').trim().slice(0, 100);
    const contact = String(m.contact || '').trim().slice(0, 120);
    const message = String(m.message || '').trim().slice(0, 2000);
    if (!name) return { error: 'Please enter your name.' };
    if (!/@/.test(contact) && (contact.match(/\d/g) || []).length < 7) return { error: 'Please enter an email address or phone number so we can reply.' };
    if (!message) return { error: 'Please write a message.' };
    this.sql.exec("INSERT INTO messages (id, name, contact, message, lang, page, status, created) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
      randomHex(8), name, contact, message, String(m.lang || 'en').slice(0, 10), String(m.page || '').slice(0, 200), Date.now());
    return { ok: true };
  }

  listMessages(view) {
    const s = this.getSettings();
    this.sql.exec('DELETE FROM messages WHERE created < ?', Date.now() - s.retentionDays * 864e5);
    const where = { new: "WHERE status = 'new'", read: "WHERE status = 'read'" }[view] || '';
    return {
      messages: this.sql.exec(`SELECT * FROM messages ${where} ORDER BY created DESC LIMIT 500`).toArray(),
      unread: this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'").one().n,
    };
  }

  updateMessage(id, status) {
    if (!['new', 'read'].includes(status)) return false;
    this.sql.exec('UPDATE messages SET status = ? WHERE id = ?', status, id);
    return true;
  }

  deleteMessage(id) {
    this.sql.exec('DELETE FROM messages WHERE id = ?', id);
    return true;
  }

  byToken(token) {
    const r = this.sql.exec('SELECT date, start, minutes, type, type_name, mode, name, status FROM bookings WHERE token = ?', String(token)).toArray()[0];
    if (!r) return null;
    const t = this.getSettings().visitTypes.find((v) => v.id === r.type);
    return { ...r, type_name_zh: (t && t.name_zh) || '' };
  }

  async cancelByToken(token) {
    const r = this.sql.exec("SELECT id, date FROM bookings WHERE token = ? AND status = 'confirmed'", String(token)).toArray()[0];
    if (!r) return false;
    this.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", r.id);
    await this.syncEvent(r.id);
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
  const lang = request.headers.get('x-lang') || 'en';
  const fail = (msg, status = 400) => bad(tr(lang, msg), status);

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
    if (body.consent !== true) return fail('Please confirm the consent box to book.');
    if (!(await db.hit(`book:${ip}`, 6, 3600))) return fail('Too many bookings from this connection. Please call or text us.', 429);
    const r = await db.createBooking({ type: body.type, date: body.date, start: Number(body.start), mode: body.mode, name: body.name, phone: body.phone, email: body.email }, { origin: url.origin });
    if (r.error) return fail(r.error);
    const b = r.booking;
    const vt = (await db.getSettings()).visitTypes.find((v) => v.id === b.type);
    return json({ ok: true, booking: { date: b.date, start: b.start, minutes: b.minutes, type_name: b.type_name, type_name_zh: (vt && vt.name_zh) || '', mode: b.mode, name: b.name }, token: b.token });
  }
  if (path === '/api/booking' && method === 'GET') {
    const b = await db.byToken(url.searchParams.get('t') || '');
    return b ? json({ booking: b }) : fail('Booking not found.', 404);
  }
  if (path === '/api/booking/cancel' && method === 'POST') {
    const body = await readJson(request, 2_000);
    return (await db.cancelByToken(body.t || '')) ? json({ ok: true }) : fail('This booking could not be cancelled. Please call or text us.', 404);
  }

  if (path === '/api/messages' && method === 'POST') {
    const body = await readJson(request, 10_000);
    if (body.website) return json({ ok: true }); // honeypot
    if (body.consent !== true) return fail('Please confirm the consent box to send your message.');
    if (!(await db.hit(`msg:${ip}`, 5, 3600))) return fail('Too many messages from this connection. Please call or text us.', 429);
    const r = await db.addMessage({ ...body, lang });
    return r.error ? fail(r.error) : json({ ok: true });
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
      const r = await db.createBooking({ ...body, start: Number(body.start) }, { admin: true, origin: url.origin });
      return r.error ? bad(r.error) : json({ ok: true, booking: r.booking });
    }
  }
  if (path === '/api/admin/google' && method === 'GET') {
    const sa = serviceAccount(env);
    return json({ keyAdded: !!sa, serviceEmail: sa ? sa.client_email : '', status: await db.googleState() });
  }
  if (path === '/api/admin/google/test' && method === 'POST') {
    const body = await readJson(request, 2_000);
    return json(await db.testGoogle(String(body.calendarId || '').trim()));
  }
  if ((path === '/api/admin/google/sync' || path === '/api/admin/apple/sync') && method === 'POST') return json(await db.syncUpcoming(url.origin));
  if (path === '/api/admin/apple' && method === 'GET') {
    const acct = appleAccount(env);
    return json({ added: !!acct, appleId: acct ? acct.id : '', status: await db.calState('apple') });
  }
  if (path === '/api/admin/apple/calendars' && method === 'POST') return json(await db.appleCalendars());
  if (path === '/api/admin/schedule' && method === 'GET') {
    const r = await db.schedule(url.searchParams.get('from') || '', url.searchParams.get('to') || '');
    return r ? json(r) : bad('Choose a date range of up to two months.');
  }
  if (path === '/api/admin/blocks' && method === 'POST') {
    const body = await readJson(request, 100_000);
    const add = Array.isArray(body.add) ? body.add.slice(0, 500) : [];
    const remove = Array.isArray(body.remove) ? body.remove.slice(0, 500) : [];
    return json(await db.updateBlocks(add, remove));
  }
  if (path === '/api/admin/messages' && method === 'GET') return json(await db.listMessages(url.searchParams.get('view') || 'all'));
  const mm = path.match(/^\/api\/admin\/messages\/([a-f0-9]+)$/);
  if (mm) {
    if (method === 'PATCH') { const body = await readJson(request, 2_000); return (await db.updateMessage(mm[1], body.status)) ? json({ ok: true }) : bad('Invalid status'); }
    if (method === 'DELETE') { await db.deleteMessage(mm[1]); return json({ ok: true }); }
  }
  const m = path.match(/^\/api\/admin\/bookings\/([a-f0-9]+)$/);
  if (m) {
    if (method === 'PATCH') { const b = await db.updateBooking(m[1], await readJson(request, 5_000), url.origin); return b ? json({ booking: b }) : bad('Not found', 404); }
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
      .on('body', { element(el) { el.append('<script src="/admin/i18n.js"></script><script src="/admin/editor.js" defer></script>', { html: true }); } });
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
        // Each admin section has its own address (/admin/bookings, /admin/availability, …); all of them are the admin page
        const section = /^\/admin\/(bookings|messages|website|availability|clinic)\/?$/.test(url.pathname);
        const res = await env.ASSETS.fetch(section ? new Request(new URL('/admin/', url), request) : request);
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
      if (url.pathname.startsWith('/api/')) return bad(tr(request.headers.get('x-lang'), 'Something went wrong. Please try again, or call or text us.'), 500);
      return env.ASSETS.fetch(request); // never take the site down: fall back to the plain page
    }
  },
};
