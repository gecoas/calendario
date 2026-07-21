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

function eventId(event) {
  return crypto.createHash('sha1').update(`${event.uid || ''}:${event.start?.toISOString() || ''}:${event.summary || ''}`).digest('hex');
}

function normalizeEvent(raw, visibleMap) {
  const id = eventId(raw);
  return {
    id,
    title: raw.summary || 'Sin titulo',
    description: raw.description || '',
    location: raw.location || '',
    start: raw.start ? raw.start.toISOString() : null,
    end: raw.end ? raw.end.toISOString() : null,
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
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function buildMailHtml({ title, events, audience }) {
  const intro = audience === 'families' ? 'Eventos visibles para las familias.' : 'Eventos previstos para el profesorado.';
  const items = events.map((event) => `
    <li>
      <strong>${escapeHtml(formatDate(event.start))} - ${escapeHtml(event.title)}</strong>
      ${event.location ? `<br><span>${escapeHtml(event.location)}</span>` : ''}
      ${event.description ? `<br><small>${escapeHtml(event.description)}</small>` : ''}
    </li>`).join('');
  return `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><p>${intro}</p><ul>${items || '<li>No hay eventos en el rango seleccionado.</li>'}</ul></body></html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
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

async function createFamilyPdf(events, title) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(20).text(title || 'Eventos del trimestre', { align: 'center' });
    doc.moveDown();
    if (!events.length) doc.fontSize(12).text('No hay eventos visibles para familias en el rango seleccionado.');
    events.forEach((event) => {
      doc.fontSize(13).text(`${formatDate(event.start)} - ${event.title}`, { continued: false });
      if (event.location) doc.fontSize(10).text(event.location);
      if (event.description) doc.fontSize(10).text(event.description.replace(/\s+/g, ' '));
      doc.moveDown(0.7);
    });
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
      const html = buildMailHtml({ title: item.title, events, audience: item.audience });
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

  app.get('/api/events', async (req, res, next) => {
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

  app.post('/api/mail/preview', requireAdmin, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.body.from, req.body.to);
      const filtered = req.body.audience === 'families' ? events.filter((event) => event.visibleToFamilies) : events;
      res.json({ html: buildMailHtml({ title: req.body.title || 'Eventos', events: filtered, audience: req.body.audience }), events: filtered });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mail/send', requireAdmin, async (req, res, next) => {
    try {
      const events = filterByRange(await fetchEvents(), req.body.from, req.body.to);
      const html = buildMailHtml({ title: req.body.title || 'Eventos', events, audience: 'teachers' });
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
      const pdf = await createFamilyPdf(events, req.body.title || 'Eventos del trimestre');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="eventos-familias.pdf"');
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
