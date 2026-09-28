const fs = require('node:fs');

const securityVariables = [
  { name: 'ADMIN_PASSWORD', minimumLength: 8 },
  { name: 'SESSION_SECRET', minimumLength: 32 }
];

const placeholders = new Set([
  'pon-aqui-la-contrasena-real',
  'pon-aqui-un-secreto-largo',
  'cambia-esta-contrasena',
  'change-me-in-production'
]);

function reportInvalid(variable, reason) {
  console.error(`${variable} ${reason}`);
}

function normalizeComposeValue(value) {
  return value.replace(/\$\$/g, '$');
}

function validateValue(environment, { name, minimumLength }) {
  const value = environment[name];
  if (typeof value !== 'string') {
    reportInvalid(name, 'debe estar definido como valor de texto en la configuración efectiva de Compose');
    return false;
  }

  const normalized = normalizeComposeValue(value).trim();
  if (normalized.length < minimumLength) {
    reportInvalid(name, `debe tener al menos ${minimumLength} caracteres en la configuración efectiva de Compose`);
    return false;
  }
  if (placeholders.has(normalized.toLowerCase())) {
    reportInvalid(name, 'conserva un valor de ejemplo en la configuración efectiva de Compose');
    return false;
  }

  return true;
}

function main() {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) {
    console.error('No se pudo validar la configuración efectiva de Compose');
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    console.error('No se pudo leer la configuración efectiva de Compose');
    process.exitCode = 1;
    return;
  }

  const environment = config?.services?.calendario?.environment;
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    console.error('No se pudo validar el entorno efectivo del servicio calendario');
    process.exitCode = 1;
    return;
  }

  let valid = true;
  for (const variable of securityVariables) {
    if (!validateValue(environment, variable)) valid = false;
  }
  if (!valid) process.exitCode = 1;
}

main();
