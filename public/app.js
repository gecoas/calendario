const calendarEl = document.querySelector('#calendar');
const courseTitleEl = document.querySelector('#course-title');
const monthTitleEl = document.querySelector('#month-title');
const previousButton = document.querySelector('#previous-month');
const nextButton = document.querySelector('#next-month');
const downloadPdfButton = document.querySelector('#download-month-pdf');
const addGoogleCalendarButton = document.querySelector('#add-google-calendar');
const eventSearchInput = document.querySelector('#event-search');
const eventSearchResults = document.querySelector('#event-search-results');
const audience = document.body.dataset.audience || 'families';
const teacherLoginEl = document.querySelector('#teacher-login');
const teacherCalendarEl = document.querySelector('#teacher-calendar');
const teacherStatusEl = document.querySelector('#teacher-login-status');
let currentMonth = new Date();
currentMonth.setDate(1);
let focusTodayOnFirstRender = true;
let pendingFocusDate = '';
let searchTimer;
let searchController;
const agendaViewport = window.matchMedia('(max-width: 1024px) and (orientation: portrait)');

function syncCalendarView() {
  const monthGrid = calendarEl.querySelector('.month-grid-view');
  const agenda = calendarEl.querySelector('.agenda-view');
  if (!monthGrid || !agenda) return;
  monthGrid.hidden = agendaViewport.matches;
  agenda.hidden = !agendaViewport.matches;
}

if (agendaViewport.addEventListener) agendaViewport.addEventListener('change', syncCalendarView);
else agendaViewport.addListener(syncCalendarView);
window.addEventListener('resize', syncCalendarView);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function monthGridRange(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const last = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const mondayOffset = (first.getDay() + 6) % 7;
  const sundayOffset = 6 - ((last.getDay() + 6) % 7);
  return { start: addDays(first, -mondayOffset), end: addDays(last, sundayOffset) };
}

function eventDates(event) {
  const dates = [];
  const startIso = event.start.slice(0, 10);
  const endIso = event.end ? event.end.slice(0, 10) : startIso;
  const start = new Date(`${startIso}T12:00:00`);
  const end = new Date(`${endIso}T12:00:00`);
  const limit = event.allDay && endIso !== startIso ? end : addDays(start, 1);
  for (let day = start; day < limit; day = addDays(day, 1)) dates.push(localIsoDate(day));
  return dates;
}

function eventTime(event) {
  if (event.allDay) return '';
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.start));
}

function agendaDate(date) {
  const value = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function loadConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  courseTitleEl.textContent = `Calendario curso ${config.schoolYear || '2026-2027'}`;
}

async function loadGoogleCalendarLink() {
  if (audience !== 'teachers' || !addGoogleCalendarButton) return;
  const response = await fetch('/api/teacher/google-calendar-link', { credentials: 'same-origin' });
  if (!response.ok) {
    addGoogleCalendarButton.hidden = true;
    return;
  }
  const data = await response.json();
  addGoogleCalendarButton.href = data.url;
  addGoogleCalendarButton.hidden = false;
}

function googleLoginMessage() {
  const value = new URLSearchParams(window.location.search).get('google');
  if (value === 'not-configured') return 'Acceso con Google no configurado todavia.';
  return '';
}

async function loadEvents() {
  const range = monthGridRange(currentMonth);
  const params = new URLSearchParams({ audience, from: localIsoDate(range.start), to: localIsoDate(range.end) });
  const response = await fetch(`/api/events?${params}`);
  const events = await response.json();
  if (!response.ok) throw new Error(events.error || 'No se han podido cargar los eventos');
  renderCalendar(events, range);
}

function renderCalendar(events, range) {
  const eventsByDate = new Map();
  const todayKey = localIsoDate(new Date());
  events.forEach((event) => {
    eventDates(event).forEach((date) => {
      if (!eventsByDate.has(date)) eventsByDate.set(date, []);
      eventsByDate.get(date).push(event);
    });
  });
  monthTitleEl.textContent = new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(currentMonth);
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const cells = weekdays.map((day) => `<div class="weekday">${day}</div>`);
  for (let day = new Date(range.start); day <= range.end; day = addDays(day, 1)) {
    const dateKey = localIsoDate(day);
    const dayEvents = eventsByDate.get(dateKey) || [];
    const outside = day.getMonth() !== currentMonth.getMonth();
    const today = dateKey === todayKey;
    cells.push(`
      <div class="month-cell ${outside ? 'outside' : ''} ${today ? 'today' : ''}" data-date="${dateKey}">
        <div class="day-number">${day.getDate()}</div>
        <div class="day-events">
          ${dayEvents.map((event) => `<div class="month-event ${event.calendarSource === 'teachers' ? 'teacher-calendar-event' : ''}" title="${escapeHtml(event.title)}">${eventTime(event) ? `${eventTime(event)} ` : ''}${escapeHtml(event.title)}</div>`).join('')}
        </div>
      </div>
    `);
  }
  const firstMonthDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const lastMonthDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
  const agendaDays = [];
  for (let day = firstMonthDay; day <= lastMonthDay; day = addDays(day, 1)) {
    const dateKey = localIsoDate(day);
    const dayEvents = eventsByDate.get(dateKey) || [];
    const today = dateKey === todayKey;
    if (!dayEvents.length && !today) continue;
    agendaDays.push(`<section class="agenda-day ${today ? 'today' : ''}" data-date="${dateKey}"><h3>${escapeHtml(agendaDate(day))}${today ? ' · Hoy' : ''}</h3><div class="agenda-day-events">${dayEvents.map((event) => `
      <article class="agenda-event ${event.allDay ? 'all-day-agenda-event' : ''} ${event.calendarSource === 'teachers' ? 'teacher-calendar-event' : ''}" title="${escapeHtml(event.title)}">
        ${eventTime(event) ? `<time>${eventTime(event)}</time>` : ''}
        <span>${escapeHtml(event.title)}</span>
      </article>`).join('') || (today ? '<p class="agenda-no-events">Hoy no hay eventos.</p>' : '')}</div></section>`);
  }
  calendarEl.innerHTML = `
    <div class="month-grid-view">${cells.join('')}</div>
    <div class="agenda-view">${agendaDays.join('') || '<p class="agenda-empty">No hay eventos este mes.</p>'}</div>
  `;
  syncCalendarView();
  const focusDate = pendingFocusDate || (focusTodayOnFirstRender ? todayKey : '');
  if (focusDate) {
    focusTodayOnFirstRender = false;
    const selector = agendaViewport.matches ? '.agenda-day' : '.month-cell';
    requestAnimationFrame(() => [...calendarEl.querySelectorAll(`${selector}[data-date]`)].find((element) => element.dataset.date === focusDate)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    pendingFocusDate = '';
  }
}

function searchResultDate(event) {
  const date = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(event.start));
  const time = eventTime(event);
  return `${date}${time ? ` · ${time}` : ' · Todo el día'}`;
}

async function searchEvents(query) {
  if (searchController) searchController.abort();
  if (query.trim().length < 2) {
    eventSearchResults.hidden = true;
    eventSearchResults.innerHTML = '';
    return;
  }
  searchController = new AbortController();
  eventSearchResults.hidden = false;
  eventSearchResults.innerHTML = '<p class="search-message">Buscando…</p>';
  try {
    const params = new URLSearchParams({ audience, q: query.trim() });
    const response = await fetch(`/api/events/search?${params}`, { signal: searchController.signal });
    const events = await response.json();
    if (!response.ok) throw new Error(events.error || 'No se pudo buscar');
    eventSearchResults.innerHTML = events.length ? events.map((event) => `
      <button type="button" class="search-result ${event.calendarSource === 'teachers' ? 'teacher-calendar-event' : ''}" data-search-date="${String(event.start).slice(0, 10)}">
        <time>${escapeHtml(searchResultDate(event))}</time>
        <span><strong>${escapeHtml(event.title)}</strong>${event.location ? `<small>${escapeHtml(event.location)}</small>` : ''}</span>
      </button>
    `).join('') : '<p class="search-message">No se encontraron eventos en este curso.</p>';
  } catch (error) {
    if (error.name !== 'AbortError') eventSearchResults.innerHTML = `<p class="search-message">${escapeHtml(error.message)}</p>`;
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

previousButton.addEventListener('click', () => {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
  loadEvents().catch(() => calendarEl.innerHTML = '');
});
nextButton.addEventListener('click', () => {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  loadEvents().catch(() => calendarEl.innerHTML = '');
});

function downloadMonthPdf() {
  const first = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const last = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
  const params = new URLSearchParams({ audience, from: localIsoDate(first), to: localIsoDate(last), month: localIsoDate(currentMonth) });
  window.location.href = `/api/calendar/pdf?${params}`;
}

downloadPdfButton.addEventListener('click', downloadMonthPdf);

eventSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchEvents(eventSearchInput.value), 250);
});
eventSearchResults.addEventListener('click', (event) => {
  const result = event.target.closest('[data-search-date]');
  if (!result) return;
  pendingFocusDate = result.dataset.searchDate;
  const date = new Date(`${pendingFocusDate}T12:00:00`);
  currentMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  loadEvents().catch(() => calendarEl.innerHTML = '');
});

async function teacherLogin() {
  teacherStatusEl.textContent = 'Comprobando correo...';
  const response = await fetch('/api/teacher/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: document.querySelector('#teacher-email').value })
  });
  const body = await response.json();
  if (!response.ok) {
    teacherStatusEl.textContent = body.error || 'No se ha podido entrar';
    return;
  }
  teacherLoginEl.hidden = true;
  teacherCalendarEl.hidden = false;
  await loadConfig();
  await loadEvents();
  await loadGoogleCalendarLink();
}

async function loadTeacherSession() {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  const session = await response.json();
  if (!session.teacher) {
    teacherStatusEl.textContent = googleLoginMessage();
    return;
  }
  teacherLoginEl.hidden = true;
  teacherCalendarEl.hidden = false;
  await loadConfig();
  await loadEvents();
  await loadGoogleCalendarLink();
}

if (audience === 'teachers') {
  document.querySelector('#teacher-login-button').addEventListener('click', () => teacherLogin().catch((error) => teacherStatusEl.textContent = error.message));
  document.querySelector('#teacher-email').addEventListener('keydown', (event) => { if (event.key === 'Enter') teacherLogin(); });
  loadTeacherSession().catch((error) => teacherStatusEl.textContent = error.message);
} else {
  loadConfig();
  loadEvents().catch(() => calendarEl.innerHTML = '');
}
