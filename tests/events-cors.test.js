const test = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../src/server');

test('permite a la intranet consultar eventos con credenciales y solo desde su origen', async (t) => {
  const app = await createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const preflight = await fetch(`${baseUrl}/api/events?audience=teachers`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://intranet.gecoas.es', 'Access-Control-Request-Method': 'GET' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://intranet.gecoas.es');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

  const teacherEvents = await fetch(`${baseUrl}/api/events?audience=teachers`, {
    headers: { Origin: 'https://intranet.gecoas.es' }
  });
  assert.equal(teacherEvents.status, 401);
  assert.equal(teacherEvents.headers.get('access-control-allow-origin'), 'https://intranet.gecoas.es');

  const foreignOrigin = await fetch(`${baseUrl}/api/events?audience=teachers`, {
    headers: { Origin: 'https://example.invalid' }
  });
  assert.equal(foreignOrigin.headers.get('access-control-allow-origin'), null);
});
