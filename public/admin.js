const loginView = document.querySelector('#login');
const adminView = document.querySelector('#admin');
const loginStatus = document.querySelector('#login-status');
const eventsStatus = document.querySelector('#events-status');
const mailStatus = document.querySelector('#mail-status');
const pdfStatus = document.querySelector('#pdf-status');
const settingsStatus = document.querySelector('#settings-status');

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function setRange(from, to, days) {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + days);
  from.value = isoDate(start);
  to.value = isoDate(end);
}

function setQuarter(from, to) {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  from.value = isoDate(new Date(now.getFullYear(), quarter * 3, 1));
  to.value = isoDate(new Date(now.getFullYear(), quarter * 3 + 3, 0));
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatEventDate(event) {
  if (event.allDay) {
    return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(event.start));
  }
  return formatDate(event.start);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (response.status === 401) throw new Error('Sesion caducada. Vuelve a entrar como administrador y guarda de nuevo.');
  if (!response.ok) throw new Error(body.error || 'Error en la solicitud');
  return body;
}

async function login() {
  loginStatus.textContent = 'Comprobando acceso...';
  try {
    await request('/api/login', { method: 'POST', body: JSON.stringify({ password: document.querySelector('#password').value }) });
    loginView.hidden = true;
    adminView.hidden = false;
    await initializeAdmin();
  } catch (error) {
    loginStatus.textContent = error.message;
  }
}

async function initializeAdmin() {
  setRange(document.querySelector('#events-from'), document.querySelector('#events-to'), 90);
  setRange(document.querySelector('#mail-from'), document.querySelector('#mail-to'), 7);
  setQuarter(document.querySelector('#pdf-from'), document.querySelector('#pdf-to'));
  const config = await request('/api/config');
  const publicUrl = `${config.publicBaseUrl || window.location.origin}/familias`;
  document.querySelector('#family-url').value = publicUrl;
  await loadAdminConfig();
  await loadEvents();
}

async function loadAdminConfig() {
  const config = await request('/api/admin/config');
  document.querySelector('#school-year').value = config.schoolYear || '2026-2027';
  document.querySelector('#calendar-url').value = config.googleCalendar.icsUrl || '';
  document.querySelector('#calendar-resolved-url').value = config.googleCalendar.resolvedIcsUrl || '';
  document.querySelector('#mail-from-address').value = config.mail.from || '';
  document.querySelector('#mail-admin-recipient').value = config.mail.recipients.admin || '';
  document.querySelector('#mail-teachers-recipient').value = config.mail.recipients.teachers || '';
  document.querySelector('#smtp-host').value = config.mail.smtp.host || '';
  document.querySelector('#smtp-port').value = config.mail.smtp.port || 587;
  document.querySelector('#smtp-secure').value = String(Boolean(config.mail.smtp.secure));
  document.querySelector('#smtp-user').value = config.mail.smtp.user || '';
  document.querySelector('#smtp-pass').placeholder = config.mail.smtp.hasPass ? 'Contrasena guardada; dejar en blanco para no cambiar' : 'Sin contrasena guardada';
  document.querySelector('#recipient option[value="admin"]').textContent = config.mail.recipients.admin ? `Cuenta administrador (${config.mail.recipients.admin})` : 'Cuenta administrador';
  document.querySelector('#recipient option[value="teachers"]').textContent = config.mail.recipients.teachers || 'profesores@alcaste-lasfuentes.com';
}

async function saveSettings() {
  settingsStatus.textContent = 'Guardando configuracion...';
  const config = await request('/api/admin/config', {
    method: 'PUT',
    body: JSON.stringify({
      googleCalendar: { icsUrl: document.querySelector('#calendar-url').value },
      schoolYear: document.querySelector('#school-year').value,
      mail: {
        from: document.querySelector('#mail-from-address').value,
        recipients: {
          admin: document.querySelector('#mail-admin-recipient').value,
          teachers: document.querySelector('#mail-teachers-recipient').value
        },
        smtp: {
          host: document.querySelector('#smtp-host').value,
          port: document.querySelector('#smtp-port').value,
          secure: document.querySelector('#smtp-secure').value === 'true',
          user: document.querySelector('#smtp-user').value,
          pass: document.querySelector('#smtp-pass').value
        }
      }
    })
  });
  document.querySelector('#calendar-resolved-url').value = config.googleCalendar.resolvedIcsUrl || '';
  document.querySelector('#smtp-pass').value = '';
  await loadAdminConfig();
  settingsStatus.textContent = 'Configuracion guardada';
  await loadEvents();
}

async function loadEvents() {
  eventsStatus.textContent = 'Cargando eventos...';
  const params = new URLSearchParams({ from: document.querySelector('#events-from').value, to: document.querySelector('#events-to').value });
  const events = await request(`/api/events?${params}`);
  eventsStatus.textContent = `${events.length} eventos encontrados`;
  document.querySelector('#admin-events').innerHTML = events.map((event) => `
    <article class="event">
      <time>${formatEventDate(event)}</time>
      <div>
        <h3>${escapeHtml(event.title)}</h3>
        ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ''}
      </div>
      <label>
        <span class="badge ${event.visibleToFamilies ? '' : 'private'}">${event.visibleToFamilies ? 'Familias' : 'Solo profesores'}</span>
        <input type="checkbox" data-event-id="${event.id}" ${event.visibleToFamilies ? 'checked' : ''}>
      </label>
    </article>
  `).join('') || '<p>No hay eventos en el rango seleccionado. Revisa la URL ICS del calendario de Google.</p>';
}

async function changeVisibility(input) {
  await request(`/api/events/${input.dataset.eventId}/visibility`, {
    method: 'PUT',
    body: JSON.stringify({ visibleToFamilies: input.checked })
  });
  await loadEvents();
}

function mailPayload() {
  return {
    from: document.querySelector('#mail-from').value,
    to: document.querySelector('#mail-to').value,
    title: document.querySelector('#mail-title').value,
    recipientKey: document.querySelector('#recipient').value
  };
}

async function previewMail() {
  mailStatus.textContent = 'Generando previsualizacion...';
  const data = await request('/api/mail/preview', { method: 'POST', body: JSON.stringify({ ...mailPayload(), audience: 'teachers' }) });
  document.querySelector('#mail-preview').innerHTML = data.html;
  mailStatus.textContent = `${data.events.length} eventos incluidos`;
}

async function sendMail() {
  mailStatus.textContent = 'Enviando correo...';
  await request('/api/mail/send', { method: 'POST', body: JSON.stringify(mailPayload()) });
  mailStatus.textContent = 'Correo enviado';
}

async function scheduleMail() {
  const sendAt = document.querySelector('#send-at').value;
  if (!sendAt) {
    mailStatus.textContent = 'Selecciona fecha y hora para programar el envio';
    return;
  }
  mailStatus.textContent = 'Programando envio...';
  await request('/api/mail/schedule', { method: 'POST', body: JSON.stringify({ ...mailPayload(), sendAt: new Date(sendAt).toISOString() }) });
  mailStatus.textContent = 'Envio programado';
  await loadScheduled();
}

async function downloadPdf() {
  pdfStatus.textContent = 'Creando PDF...';
  const response = await fetch('/api/families/pdf', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: document.querySelector('#pdf-from').value,
      to: document.querySelector('#pdf-to').value,
      title: document.querySelector('#pdf-title').value
    })
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'No se pudo crear el PDF');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'eventos-familias.pdf';
  link.click();
  URL.revokeObjectURL(url);
  pdfStatus.textContent = 'PDF creado';
}

async function loadScheduled() {
  const scheduled = await request('/api/mail/scheduled');
  document.querySelector('#scheduled').innerHTML = scheduled.map((item) => `
    <article class="event">
      <time>${formatDate(item.sendAt)}</time>
      <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.from)} a ${escapeHtml(item.to)} · ${escapeHtml(item.recipientKey)}</p></div>
      <span class="badge ${item.status === 'sent' ? '' : 'private'}">${escapeHtml(item.status)}</span>
    </article>
  `).join('') || '<p>No hay envios programados.</p>';
}

document.querySelector('#login-button').addEventListener('click', login);
document.querySelector('#password').addEventListener('keydown', (event) => { if (event.key === 'Enter') login(); });
document.querySelector('#load-events').addEventListener('click', () => loadEvents().catch((error) => eventsStatus.textContent = error.message));
document.querySelector('#save-settings').addEventListener('click', () => saveSettings().catch((error) => settingsStatus.textContent = error.message));
document.querySelector('#admin-events').addEventListener('change', (event) => {
  if (event.target.matches('[data-event-id]')) changeVisibility(event.target).catch((error) => eventsStatus.textContent = error.message);
});
document.querySelector('#preview-mail').addEventListener('click', () => previewMail().catch((error) => mailStatus.textContent = error.message));
document.querySelector('#send-mail').addEventListener('click', () => sendMail().catch((error) => mailStatus.textContent = error.message));
document.querySelector('#schedule-mail').addEventListener('click', () => scheduleMail().catch((error) => mailStatus.textContent = error.message));
document.querySelector('#download-pdf').addEventListener('click', () => downloadPdf().catch((error) => pdfStatus.textContent = error.message));
document.querySelector('#load-scheduled').addEventListener('click', () => loadScheduled());
document.querySelector('#quarter-teachers').addEventListener('click', () => setQuarter(document.querySelector('#mail-from'), document.querySelector('#mail-to')));
document.querySelector('#quarter-families').addEventListener('click', () => setQuarter(document.querySelector('#pdf-from'), document.querySelector('#pdf-to')));
document.querySelector('#copy-url').addEventListener('click', async () => navigator.clipboard.writeText(document.querySelector('#family-url').value));

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`#${tab.dataset.tab}`).classList.add('active');
  });
});
