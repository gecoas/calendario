const calendarEl = document.querySelector('#calendar');
const courseTitleEl = document.querySelector('#course-title');
const monthTitleEl = document.querySelector('#month-title');
const previousButton = document.querySelector('#previous-month');
const nextButton = document.querySelector('#next-month');
const audience = document.body.dataset.audience || 'families';
const teacherLoginEl = document.querySelector('#teacher-login');
const teacherCalendarEl = document.querySelector('#teacher-calendar');
const teacherStatusEl = document.querySelector('#teacher-login-status');
let currentMonth = new Date();
currentMonth.setDate(1);

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

async function loadConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  courseTitleEl.textContent = `Calendario curso ${config.schoolYear || '2026-2027'}`;
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
  events.forEach((event) => {
    eventDates(event).forEach((date) => {
      if (!eventsByDate.has(date)) eventsByDate.set(date, []);
      eventsByDate.get(date).push(event);
    });
  });
  monthTitleEl.textContent = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(currentMonth);
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const cells = weekdays.map((day) => `<div class="weekday">${day}</div>`);
  for (let day = new Date(range.start); day <= range.end; day = addDays(day, 1)) {
    const dateKey = localIsoDate(day);
    const dayEvents = eventsByDate.get(dateKey) || [];
    const outside = day.getMonth() !== currentMonth.getMonth();
    cells.push(`
      <div class="month-cell ${outside ? 'outside' : ''}">
        <div class="day-number">${day.getDate()}</div>
        <div class="day-events">
          ${dayEvents.map((event) => `<div class="month-event" title="${escapeHtml(event.title)}">${eventTime(event) ? `${eventTime(event)} ` : ''}${escapeHtml(event.title)}</div>`).join('')}
        </div>
      </div>
    `);
  }
  calendarEl.innerHTML = cells.join('');
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
}

if (audience === 'teachers') {
  document.querySelector('#teacher-login-button').addEventListener('click', () => teacherLogin().catch((error) => teacherStatusEl.textContent = error.message));
  document.querySelector('#teacher-email').addEventListener('keydown', (event) => { if (event.key === 'Enter') teacherLogin(); });
} else {
  loadConfig();
  loadEvents().catch(() => calendarEl.innerHTML = '');
}
