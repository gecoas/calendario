const eventsEl = document.querySelector('#events');
const fromEl = document.querySelector('#from');
const toEl = document.querySelector('#to');
const titleEl = document.querySelector('#school-title');
const statusEl = document.querySelector('#status');

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function setDefaultRange() {
  const today = new Date();
  const later = new Date();
  later.setDate(today.getDate() + 90);
  fromEl.value = isoDate(today);
  toEl.value = isoDate(later);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

async function loadConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  titleEl.textContent = config.schoolName || 'Calendario escolar';
}

async function loadEvents() {
  statusEl.textContent = 'Cargando eventos...';
  eventsEl.innerHTML = '';
  const params = new URLSearchParams({ audience: 'families', from: fromEl.value, to: toEl.value });
  const response = await fetch(`/api/events?${params}`);
  const events = await response.json();
  if (!response.ok) throw new Error(events.error || 'No se han podido cargar los eventos');
  statusEl.textContent = `${events.length} eventos visibles para familias`;
  eventsEl.innerHTML = events.map((event) => `
    <article class="event">
      <time>${formatDate(event.start)}</time>
      <div>
        <h3>${escapeHtml(event.title)}</h3>
        ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ''}
        ${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}
      </div>
      <span class="badge">Familias</span>
    </article>
  `).join('') || '<p>No hay eventos publicados para este rango.</p>';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

document.querySelector('#filter').addEventListener('click', () => loadEvents().catch((error) => statusEl.textContent = error.message));
setDefaultRange();
loadConfig();
loadEvents().catch((error) => statusEl.textContent = error.message);
