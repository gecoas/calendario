const express = require('express');
const session = require('express-session');
const ical = require('node-ical');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const configPath = path.join(rootDir, 'config', 'app.config.json');
const dataDir = path.join(rootDir, 'data');
const runtimeConfigPath = path.join(dataDir, 'app.config.json');
const visibilityPath = path.join(dataDir, 'visibility.json');
const scheduledPath = path.join(dataDir, 'scheduled-mails.json');
const noticesPath = path.join(dataDir, 'notices.json');
const madridTimeZone = 'Europe/Madrid';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function saveConfig(updates) {
  const config = await loadConfig(false);
  if (Object.prototype.hasOwnProperty.call(updates, 'schoolYear')) {
    config.schoolYear = updates.schoolYear;
  }
  config.googleCalendar = { ...(config.googleCalendar || {}), ...(updates.googleCalendar || {}) };
  if (updates.mail) {
    config.mail = {
      ...(config.mail || {}),
      ...updates.mail,
      smtp: { ...(config.mail?.smtp || {}), ...(updates.mail.smtp || {}) },
      recipients: { ...(config.mail?.recipients || {}), ...(updates.mail.recipients || {}) }
    };
  }
  delete config.sessionSecret;
  await writeJson(runtimeConfigPath, config);
  return config;
}

function normalizeCalendarUrl(url) {
  if (!url) return '';
  const value = String(url).trim();
  if (value.includes('/calendar/ical/')) return value;
  try {
    const parsed = new URL(value);
    const cid = parsed.searchParams.get('cid');
    const src = parsed.searchParams.get('src');
    const calendarId = src || (cid ? Buffer.from(cid, 'base64').toString('utf8') : '');
    if (!calendarId) return value;
    return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
  } catch (_error) {
    return value;
  }
}

function mergeConfig(base, runtime) {
  return {
    ...base,
    ...runtime,
    admin: { ...(base.admin || {}), ...(runtime.admin || {}) },
    googleCalendar: { ...(base.googleCalendar || {}), ...(runtime.googleCalendar || {}) },
    mail: {
      ...(base.mail || {}),
      ...(runtime.mail || {}),
      smtp: { ...(base.mail?.smtp || {}), ...(runtime.mail?.smtp || {}) },
      recipients: { ...(base.mail?.recipients || {}), ...(runtime.mail?.recipients || {}) }
    }
  };
}

async function loadConfig(applyEnv = true) {
  const runtimeConfig = await readJson(runtimeConfigPath, {});
  const config = mergeConfig(await readJson(configPath, {}), runtimeConfig);
  config.admin = config.admin || {};
  config.mail = config.mail || {};
  config.mail.smtp = config.mail.smtp || {};
  config.mail.recipients = config.mail.recipients || {};
  config.googleCalendar = config.googleCalendar || {};
  if (applyEnv) {
    config.admin.password = process.env.ADMIN_PASSWORD || config.admin.password;
    config.mail.from = runtimeConfig.mail?.from || config.mail.from;
    config.mail.recipients.admin = runtimeConfig.mail?.recipients?.admin || config.mail.recipients.admin;
    config.mail.recipients.teachers = runtimeConfig.mail?.recipients?.teachers || config.mail.recipients.teachers;
    config.mail.smtp.host = runtimeConfig.mail?.smtp?.host || process.env.SMTP_HOST || config.mail.smtp.host;
    config.mail.smtp.port = Number(runtimeConfig.mail?.smtp?.port || process.env.SMTP_PORT || config.mail.smtp.port || 587);
    config.mail.smtp.secure = typeof runtimeConfig.mail?.smtp?.secure === 'boolean' ? runtimeConfig.mail.smtp.secure : String(process.env.SMTP_SECURE || config.mail.smtp.secure) === 'true';
    config.mail.smtp.user = runtimeConfig.mail?.smtp?.user || process.env.SMTP_USER || config.mail.smtp.user;
    config.mail.smtp.pass = runtimeConfig.mail?.smtp?.pass || process.env.SMTP_PASS || config.mail.smtp.pass;
    config.googleCalendar.icsUrl = runtimeConfig.googleCalendar?.icsUrl || process.env.GOOGLE_CALENDAR_ICS_URL || config.googleCalendar.icsUrl;
  }
  config.sessionSecret = process.env.SESSION_SECRET || crypto.createHash('sha256').update(config.admin.password || 'calendar').digest('hex');
  return config;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

function requireCalendarAccess(req, res, next) {
  if (req.query.audience === 'families') return next();
  if (req.session && (req.session.admin || req.session.teacher)) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

function eventId(event) {
  return crypto.createHash('sha1').update(`${event.uid || ''}:${event.start?.toISOString() || ''}:${event.summary || ''}`).digest('hex');
}

function normalizeEvent(raw, visibleMap) {
  const id = eventId(raw);
  const allDay = raw.datetype === 'date' || raw.start?.dateOnly === true;
  return {
    id,
    title: raw.summary || 'Sin titulo',
    description: raw.description || '',
    location: raw.location || '',
    start: raw.start ? raw.start.toISOString() : null,
    end: raw.end ? raw.end.toISOString() : null,
    allDay,
    visibleToFamilies: Boolean(visibleMap[id])
  };
}

async function fetchEvents() {
  const config = await loadConfig();
  const visibleMap = await readJson(visibilityPath, {});
  const calendarUrl = normalizeCalendarUrl(config.googleCalendar.icsUrl);
  if (!calendarUrl) return [];
  const response = await fetch(calendarUrl);
  if (!response.ok) {
    throw new Error(`Google Calendar no entrega un iCal valido (${response.status}). Usa la direccion publica o secreta en formato iCal del calendario.`);
  }
  const calendarText = await response.text();
  if (!calendarText.includes('BEGIN:VCALENDAR')) {
    throw new Error('La URL configurada no devuelve un calendario iCal valido. Usa la direccion publica o secreta en formato iCal del calendario.');
  }
  const parsed = await ical.async.parseICS(calendarText);
  return Object.values(parsed)
    .filter((item) => item.type === 'VEVENT' && item.start)
    .map((item) => normalizeEvent(item, visibleMap))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function filterByRange(events, from, to) {
  const start = from ? new Date(`${from}T00:00:00`) : new Date('1970-01-01T00:00:00');
  const end = to ? new Date(`${to}T23:59:59`) : new Date('2999-12-31T23:59:59');
  return events.filter((event) => {
    const eventStart = new Date(event.start);
    return eventStart >= start && eventStart <= end;
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: madridTimeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatEventDate(event) {
  if (event.allDay) {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: madridTimeZone,
      weekday: 'short',
      day: '2-digit',
      month: '2-digit'
    }).format(new Date(event.start));
  }
  return formatDate(event.start);
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function formatMailDate(event) {
  const date = new Intl.DateTimeFormat('es-ES', {
    timeZone: madridTimeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(new Date(event.start));
  if (event.allDay) return capitalize(date);
  const time = new Intl.DateTimeFormat('es-ES', {
    timeZone: madridTimeZone,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(event.start));
  return `${capitalize(date)}, ${time}`;
}

function formatMailDay(event) {
  return capitalize(new Intl.DateTimeFormat('es-ES', {
    timeZone: madridTimeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(new Date(event.start)));
}

function formatMailTime(event) {
  if (event.allDay) return '';
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: madridTimeZone,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(event.start));
}

function normalizeNotice(input) {
  return {
    id: input.id || crypto.randomUUID(),
    title: String(input.title || '').trim(),
    body: String(input.body || '').trim(),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

async function selectedNotices(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  if (!wanted.size) return [];
  return (await readJson(noticesPath, [])).filter((notice) => wanted.has(notice.id));
}

function eventDateKeys(event) {
  const dates = [];
  const startIso = event.start.slice(0, 10);
  const endIso = event.end ? event.end.slice(0, 10) : startIso;
  const start = new Date(`${startIso}T12:00:00`);
  const end = new Date(`${endIso}T12:00:00`);
  const limit = event.allDay && endIso !== startIso ? end : addDays(start, 1);
  for (let day = start; day < limit; day = addDays(day, 1)) dates.push(localIsoDate(day));
  return dates;
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function monthGridRange(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const last = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  return { start: addDays(first, -((first.getDay() + 6) % 7)), end: addDays(last, 6 - ((last.getDay() + 6) % 7)) };
}

function buildMailHtml({ title, events, audience, notices = [] }) {
  const intro = audience === 'families' ? 'Eventos visibles para las familias.' : '';
  const noticeItems = notices.map((notice) => `
    <div style="margin:0 0 12px;padding:14px 16px;border:1px solid #eadde2;border-radius:14px;background:#fff8e0;">
      <div style="color:#a61946;font-weight:800;margin-bottom:6px;">${escapeHtml(notice.title)}</div>
      <div style="color:#24141a;line-height:1.5;white-space:pre-line;">${escapeHtml(notice.body)}</div>
    </div>`).join('');
  let previousDay = '';
  const items = events.map((event) => {
    const day = formatMailDay(event);
    const time = formatMailTime(event);
    const showDay = day !== previousDay;
    previousDay = day;
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #eadde2;color:#a61946;font-weight:700;white-space:nowrap;vertical-align:top;">${showDay ? escapeHtml(day) : ''}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #eadde2;color:#24141a;font-weight:700;vertical-align:top;">${time ? `<span style="color:#a61946;margin-right:8px;">${escapeHtml(time)}</span>` : ''}${escapeHtml(event.title)}${event.location ? `<div style="font-weight:400;color:#655761;margin-top:4px;">${escapeHtml(event.location)}</div>` : ''}</td>
      </tr>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;background:#f7f2ee;font-family:Arial,Helvetica,sans-serif;color:#24141a;"><div style="max-width:760px;margin:0 auto;padding:28px;"><div style="background:#fff;border:1px solid #eadde2;border-radius:18px;overflow:hidden;"><div style="padding:24px 28px;background:#a61946;color:#fff;"><h1 style="margin:0;font-size:26px;">${escapeHtml(title)}</h1>${intro ? `<p style="margin:8px 0 0;color:#f6d7e1;">${intro}</p>` : ''}</div>${noticeItems ? `<div style="padding:20px 20px 8px;">${noticeItems}</div>` : ''}<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">${items || '<tr><td style="padding:20px;">No hay eventos en el rango seleccionado.</td></tr>'}</table></div></div></body></html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function cleanPdfText(value) {
  return String(value || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function transporterFromConfig(config) {
  if (!config.mail.smtp.host) return null;
  return nodemailer.createTransport({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    auth: config.mail.smtp.user ? { user: config.mail.smtp.user, pass: config.mail.smtp.pass } : undefined
  });
}

async function sendMail({ title, html, recipientKey }) {
  const config = await loadConfig();
  const transporter = transporterFromConfig(config);
  if (!transporter) throw new Error('SMTP no configurado');
  const to = config.mail.recipients[recipientKey];
  if (!to) throw new Error('Destinatario no configurado');
  await transporter.sendMail({ from: config.mail.from, to, subject: title, html });
}

function formatSchoolYearForTitle(schoolYear) {
  return String(schoolYear || '2026-2027').replace('-', '/');
}

function trimesterName(from) {
  const month = Number(String(from || '').slice(5, 7));
  if (month >= 9 && month <= 12) return 'primer';
  if (month >= 1 && month <= 3) return 'segundo';
  if (month >= 4 && month <= 6) return 'tercer';
  return '';
}

function trimesterTitle(from, schoolYear) {
  const trimester = trimesterName(from);
  const prefix = trimester ? `Calendario ${trimester} trimestre` : 'Calendario trimestre';
  return `${prefix} curso ${formatSchoolYearForTitle(schoolYear)}`;
}

function monthTitle(month, schoolYear) {
  const date = new Date(`${month || ''}T12:00:00`);
  const label = Number.isNaN(date.getTime()) ? 'Mes' : capitalize(new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(date));
  return `Calendario ${label} curso ${formatSchoolYearForTitle(schoolYear)}`;
}

function drawPdfMonth(doc, monthDate, events) {
  const left = 36;
  const top = 132;
  const cellWidth = 110;
  const cellHeight = 64;
  const range = monthGridRange(monthDate);
  const eventsByDate = new Map();
  events.forEach((event) => eventDateKeys(event).forEach((date) => {
    if (!eventsByDate.has(date)) eventsByDate.set(date, []);
    eventsByDate.get(date).push(event);
  }));
  doc.fontSize(15).fillColor('#a61946').text(capitalize(new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(monthDate)), left, 92);
  ['L', 'M', 'X', 'J', 'V', 'S', 'D'].forEach((day, index) => {
    doc.rect(left + index * cellWidth, top - 22, cellWidth, 22).fillAndStroke('#f4e7ec', '#eadde2');
    doc.fillColor('#a61946').fontSize(9).text(day, left + index * cellWidth, top - 17, { width: cellWidth, align: 'center' });
  });
  let index = 0;
  for (let day = new Date(range.start); day <= range.end; day = addDays(day, 1)) {
    const x = left + (index % 7) * cellWidth;
    const y = top + Math.floor(index / 7) * cellHeight;
    const outside = day.getMonth() !== monthDate.getMonth();
    doc.rect(x, y, cellWidth, cellHeight).fillAndStroke(outside ? '#f7f2ee' : '#ffffff', '#eadde2');
    doc.fillColor(outside ? '#a79aa1' : '#a61946').fontSize(8).text(String(day.getDate()), x + 4, y + 4);
    const dayEvents = eventsByDate.get(localIsoDate(day)) || [];
    let eventY = y + 15;
    dayEvents.forEach((event) => {
      const label = cleanPdfText(event.allDay ? event.title : `${formatMailDate(event).split(', ').pop()} ${event.title}`);
      if (!label) return;
      const textHeight = doc.heightOfString(label, { width: cellWidth - 8, lineGap: 0 });
      if (eventY + textHeight > y + cellHeight - 3) return;
      doc.fillColor('#24141a').fontSize(6.5).text(label, x + 4, eventY, { width: cellWidth - 8, lineGap: 0 });
      eventY += textHeight + 2;
    });
    index += 1;
  }
}

async function createFamilyPdf(events, title, from, to) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const heading = title || trimesterTitle(from);
    const start = new Date(`${from}T12:00:00`);
    const end = new Date(`${to}T12:00:00`);
    for (let month = new Date(start.getFullYear(), start.getMonth(), 1); month <= end; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
      if (month.getTime() !== new Date(start.getFullYear(), start.getMonth(), 1).getTime()) doc.addPage();
      doc.image(path.join(rootDir, 'public', 'logo.png'), 42, 30, { width: 38, height: 38 });
      doc.fillColor('#24141a').fontSize(20).text(heading, 96, 38, { width: 700 });
      drawPdfMonth(doc, month, events);
    }
    doc.end();
  });
}

async function scheduleMail(payload) {
  const scheduled = await readJson(scheduledPath, []);
  const item = { id: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(), ...payload };
  scheduled.push(item);
  await writeJson(scheduledPath, scheduled);
  planScheduledMail(item);
  return item;
}

function planScheduledMail(item) {
  const delay = new Date(item.sendAt).getTime() - Date.now();
  if (!Number.isFinite(delay) || delay <= 0 || delay > 2147483647) return;
  setTimeout(async () => {
    try {
      const events = filterByRange(await fetchEvents(), item.from, item.to);
      const notices = await selectedNotices(item.noticeIds);
      const html = buildMailHtml({ title: item.title, events, audience: item.audience, notices });
      await sendMail({ title: item.title, html, recipientKey: item.recipientKey });
      await updateScheduleStatus(item.id, 'sent');
    } catch (error) {
      await updateScheduleStatus(item.id, 'error', error.message);
    }
  }, delay);
}

async function updateScheduleStatus(id, status, error) {
  const scheduled = await readJson(scheduledPath, []);
  const updated = scheduled.map((item) => item.id === id ? { ...item, status, error, updatedAt: new Date().toISOString() } : item);
  await writeJson(scheduledPath, updated);
}

async function createApp() {
  const config = await loadConfig();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto' }
  }));
  app.use(express.static(path.join(rootDir, 'public')));

  app.get('/familias', (_req, res) => res.sendFile(path.join(rootDir, 'public', 'index.html')));
  app.get('/profesores', (_req, res) => res.sendFile(path.join(rootDir, 'public', 'profesores.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(rootDir, 'public', 'admin.html')));

  app.get('/api/config', async (_req, res) => {
    const cfg = await loadConfig();
    res.json({ schoolName: cfg.schoolName, schoolYear: cfg.schoolYear || '2026-2027', publicBaseUrl: cfg.publicBaseUrl });
  });

  app.get('/api/admin/config', requireAdmin, async (_req, res) => {
    const cfg = await loadConfig();
    res.json({
      schoolYear: cfg.schoolYear || '2026-2027',
      googleCalendar: {
        icsUrl: cfg.googleCalendar.icsUrl || '',
        resolvedIcsUrl: normalizeCalendarUrl(cfg.googleCalendar.icsUrl)
      },
      mail: {
        from: cfg.mail.from || '',
        recipients: {
          admin: cfg.mail.recipients.admin || '',
          teachers: cfg.mail.recipients.teachers || ''
        },
        smtp: {
          host: cfg.mail.smtp.host || '',
          port: cfg.mail.smtp.port || 587,
          secure: Boolean(cfg.mail.smtp.secure),
          user: cfg.mail.smtp.user || '',
          hasPass: Boolean(cfg.mail.smtp.pass)
        }
      }
    });
  });

  app.put('/api/admin/config', requireAdmin, async (req, res) => {
    const icsUrl = String(req.body.googleCalendar?.icsUrl || '').trim();
    const current = await loadConfig(false);
    const smtpPass = String(req.body.mail?.smtp?.pass || '');
    const config = await saveConfig({
      schoolYear: String(req.body.schoolYear || '2026-2027').trim(),
      googleCalendar: { icsUrl },
      mail: {
        from: String(req.body.mail?.from || '').trim(),
        recipients: {
          admin: String(req.body.mail?.recipients?.admin || '').trim(),
          teachers: String(req.body.mail?.recipients?.teachers || '').trim()
        },
        smtp: {
          host: String(req.body.mail?.smtp?.host || '').trim(),
          port: Number(req.body.mail?.smtp?.port || 587),
          secure: Boolean(req.body.mail?.smtp?.secure),
          user: String(req.body.mail?.smtp?.user || '').trim(),
          pass: smtpPass || current.mail?.smtp?.pass || ''
        }
      }
    });
    res.json({
      ok: true,
      schoolYear: config.schoolYear || '2026-2027',
      googleCalendar: {
        icsUrl: config.googleCalendar.icsUrl || '',
        resolvedIcsUrl: normalizeCalendarUrl(config.googleCalendar.icsUrl)
      },
      mail: {
        from: config.mail.from || '',
        recipients: {
          admin: config.mail.recipients.admin || '',
          teachers: config.mail.recipients.teachers || ''
        },
        smtp: {
          host: config.mail.smtp.host || '',
          port: config.mail.smtp.port || 587,
          secure: Boolean(config.mail.smtp.secure),
          user: config.mail.smtp.user || '',
          hasPass: Boolean(config.mail.smtp.pass)
        }
      }
    });
  });

  app.post('/api/login', async (req, res) => {
    const cfg = await loadConfig();
    if (req.body.password && req.body.password === cfg.admin.password) {
      req.session.admin = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Contrasena incorrecta' });
  });

  app.post('/api/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));

  app.post('/api/teacher/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email.endsWith('@alcaste-lasfuentes.com')) {
      return res.status(401).json({ error: 'Usa un correo del colegio @alcaste-lasfuentes.com' });
    }
    req.session.teacher = { email };
    return res.json({ ok: true });
  });

  app.get('/api/events', requireCalendarAccess, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.query.from, req.query.to);
      res.json(req.query.audience === 'families' ? events.filter((event) => event.visibleToFamilies) : events);
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/events/:id/visibility', requireAdmin, async (req, res) => {
    const visibleMap = await readJson(visibilityPath, {});
    if (req.body.visibleToFamilies) visibleMap[req.params.id] = true;
    else delete visibleMap[req.params.id];
    await writeJson(visibilityPath, visibleMap);
    res.json({ ok: true });
  });

  app.get('/api/notices', requireAdmin, async (_req, res) => {
    res.json(await readJson(noticesPath, []));
  });

  app.post('/api/notices', requireAdmin, async (req, res) => {
    const notice = normalizeNotice(req.body);
    if (!notice.title || !notice.body) return res.status(400).json({ error: 'El aviso necesita titulo y texto' });
    const notices = await readJson(noticesPath, []);
    notices.unshift(notice);
    await writeJson(noticesPath, notices);
    res.json(notice);
  });

  app.delete('/api/notices/:id', requireAdmin, async (req, res) => {
    const notices = await readJson(noticesPath, []);
    await writeJson(noticesPath, notices.filter((notice) => notice.id !== req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/mail/preview', requireAdmin, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.body.from, req.body.to);
      const filtered = req.body.audience === 'families' ? events.filter((event) => event.visibleToFamilies) : events;
      const notices = await selectedNotices(req.body.noticeIds);
      res.json({ html: buildMailHtml({ title: req.body.title || 'Eventos', events: filtered, audience: req.body.audience, notices }), events: filtered, notices });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mail/send', requireAdmin, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.body.from, req.body.to);
      const notices = await selectedNotices(req.body.noticeIds);
      const html = buildMailHtml({ title: req.body.title || 'Eventos', events, audience: 'teachers', notices });
      await sendMail({ title: req.body.title || 'Eventos', html, recipientKey: req.body.recipientKey || 'admin' });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mail/schedule', requireAdmin, async (req, res, next) => {
    try {
      const item = await scheduleMail({
        title: req.body.title || 'Eventos',
        from: req.body.from,
        to: req.body.to,
        recipientKey: req.body.recipientKey || 'admin',
        audience: 'teachers',
        noticeIds: Array.isArray(req.body.noticeIds) ? req.body.noticeIds.map(String) : [],
        sendAt: req.body.sendAt
      });
      res.json(item);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/mail/scheduled', requireAdmin, async (_req, res) => res.json(await readJson(scheduledPath, [])));

  app.post('/api/families/pdf', requireAdmin, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.body.from, req.body.to).filter((event) => event.visibleToFamilies);
      const cfg = await loadConfig();
      const pdf = await createFamilyPdf(events, trimesterTitle(req.body.from, cfg.schoolYear), req.body.from, req.body.to);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="eventos-familias.pdf"');
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/calendar/pdf', requireCalendarAccess, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.query.from, req.query.to);
      const filtered = req.query.audience === 'families' ? events.filter((event) => event.visibleToFamilies) : events;
      const cfg = await loadConfig();
      const pdf = await createFamilyPdf(filtered, monthTitle(req.query.month, cfg.schoolYear), req.query.from, req.query.to);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="calendario-mes.pdf"');
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: error.message || 'Error interno' });
  });

  for (const item of await readJson(scheduledPath, [])) {
    if (item.status === 'pending') planScheduledMail(item);
  }

  return app;
}

if (require.main === module) {
  createApp().then((app) => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Calendario escuchando en puerto ${port}`));
  });
}

module.exports = createApp;
