# Calendario escolar

App para publicar eventos del calendario de Google del colegio y gestionarlos desde un panel de administrador.

## Funciones

- Vista publica para familias en `/familias` con solo los eventos marcados como visibles.
- Panel de administrador en `/admin` con login por contrasena.
- Cambio del enlace de Google Calendar desde el panel de administrador.
- Marcado de eventos visibles para familias; por defecto quedan solo para profesores.
- Preparacion de correo para profesores con rango semanal o trimestral, titulo editable y destinatarios configurables.
- Envio inmediato o programado por SMTP.
- PDF trimestral para familias con los eventos visibles, descargable para adjuntar en otra app.
- Configuracion externa en `config/app.config.json` y secretos por variables de entorno.

## Configuracion

Edita `config/app.config.json` para valores no secretos como nombre del colegio, URL publica, correo remitente y destinatarios.

No subas secretos reales al repo. Para produccion usa variables de entorno como las de `.env.example`:

- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `GOOGLE_CALENDAR_ICS_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

## Google Calendar

La app lee el calendario mediante una URL de Google Calendar. Acepta una URL iCal/ICS, una URL con parametro `cid` o una URL de insercion con parametro `src`, por ejemplo `https://calendar.google.com/calendar/embed?src=...`.

El administrador puede cambiar este enlace desde `/admin`, seccion `Configuracion`.

## Desarrollo

```bash
npm install
npm run build
npm start
```

Luego abre:

- `http://localhost:3000/familias`
- `http://localhost:3000/admin`

## Persistencia

Los datos generados por la app se guardan en `data/`:

- `app.config.json`: configuracion editable desde el panel de administrador.
- `visibility.json`: eventos visibles para familias.
- `scheduled-mails.json`: envios programados y estado.

Estos ficheros no se suben a GitHub.
