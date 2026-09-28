const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repositoryRoot = path.join(__dirname, '..');
const effectiveValidatorPath = path.join(repositoryRoot, 'scripts', 'validate-effective-compose-secrets.js');
const rawValidatorPath = path.join(repositoryRoot, 'scripts', 'validate-production-env.sh');

function runValidator(t, validatorPath, contents, command = 'node') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'calendario-effective-secrets-'));
  const inputPath = path.join(directory, 'input');
  writeFileSync(inputPath, contents);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return spawnSync(command, [validatorPath, inputPath], { encoding: 'utf8' });
}

function resolvedComposeConfig(adminPassword, sessionSecret) {
  // `docker compose config --format json` doubles literal dollar signs.
  const composeOutputValue = (value) => value.replace(/\$/g, () => '$$');

  return JSON.stringify({
    services: {
      calendario: {
        environment: {
          ADMIN_PASSWORD: composeOutputValue(adminPassword),
          SESSION_SECRET: composeOutputValue(sessionSecret)
        }
      }
    }
  });
}

function validateRawEnv(t, contents) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'calendario-effective-raw-env-'));
  const envPath = path.join(directory, '.env');
  writeFileSync(envPath, contents);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; validate_production_env "$2"', '--', rawValidatorPath, envPath],
    { encoding: 'utf8' }
  );
}

test('accepts effective Compose secrets meeting length requirements', (t) => {
  const adminPassword = 'effective-admin-password';
  const sessionSecret = 'effective-session-secret-with-at-least-32-characters';
  const result = runValidator(t, effectiveValidatorPath, resolvedComposeConfig(adminPassword, sessionSecret));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('rejects short ADMIN_PASSWORD values after normalizing Compose-escaped dollars', (t) => {
  const sessionSecret = 'effective-session-secret-with-at-least-32-characters';
  const shortPasswords = [
    '$$$$', // 4 effective characters become 8 in Compose JSON.
    'abcdef$', // 7 effective characters become 8 in Compose JSON.
    'pw$$12' // The literal dollar pair is represented by four dollars.
  ];

  for (const adminPassword of shortPasswords) {
    assert.ok(adminPassword.length < 8);
    const composeConfig = resolvedComposeConfig(adminPassword, sessionSecret);
    const serializedPassword = JSON.parse(composeConfig).services.calendario.environment.ADMIN_PASSWORD;
    assert.equal(serializedPassword.length, 8);

    const result = runValidator(t, effectiveValidatorPath, composeConfig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ADMIN_PASSWORD/);
    assert.doesNotMatch(result.stderr, /\$/);
    assert.equal(result.stdout, '');
  }
});

test('rejects a 16-character SESSION_SECRET even when Compose JSON doubles every dollar', (t) => {
  const adminPassword = 'effective-admin-password';
  const sessionSecret = '$$$$$$$$$$$$$$$$';
  assert.equal(sessionSecret.length, 16);
  const composeConfig = resolvedComposeConfig(adminPassword, sessionSecret);
  const serializedSecret = JSON.parse(composeConfig).services.calendario.environment.SESSION_SECRET;
  assert.equal(serializedSecret.length, 32);

  const result = runValidator(t, effectiveValidatorPath, composeConfig);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /\$/);
  assert.equal(result.stdout, '');
});

test('accepts valid effective Compose secrets containing literal dollars', (t) => {
  const adminPassword = 'valid$admin-password';
  const sessionSecret = `${'s'.repeat(15)}$${'t'.repeat(16)}`;
  const composeConfig = resolvedComposeConfig(adminPassword, sessionSecret);
  const environment = JSON.parse(composeConfig).services.calendario.environment;
  assert.equal(environment.ADMIN_PASSWORD.length, adminPassword.length + 1);
  assert.equal(environment.SESSION_SECRET.length, sessionSecret.length + 1);

  const result = runValidator(t, effectiveValidatorPath, composeConfig);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('rejects short values produced by interpolation even when raw .env passes', (t) => {
  const rawEnv = 'ADMIN_PASSWORD=${ADMIN_PASSWORD_FROM_DEPLOYMENT_ENVIRONMENT}\n'
    + 'SESSION_SECRET=${SESSION_SECRET_FROM_DEPLOYMENT_ENVIRONMENT_WITH_A_LONG_NAME}\n';
  const rawResult = validateRawEnv(t, rawEnv);
  assert.equal(rawResult.status, 0, rawResult.stderr);

  const adminPassword = 'tiny';
  const sessionSecret = 'short';
  const result = runValidator(t, effectiveValidatorPath, resolvedComposeConfig(adminPassword, sessionSecret));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /tiny|short/);
  assert.equal(result.stdout, '');
});

test('rejects values shortened by Compose double-quoted escape decoding', (t) => {
  const rawEnv = `ADMIN_PASSWORD="${'\\n'.repeat(4)}"\n`
    + `SESSION_SECRET="${'\\n'.repeat(16)}"\n`;
  const rawResult = validateRawEnv(t, rawEnv);
  assert.equal(rawResult.status, 0, rawResult.stderr);

  const adminPassword = '\n'.repeat(4);
  const sessionSecret = '\n'.repeat(16);
  const result = runValidator(t, effectiveValidatorPath, resolvedComposeConfig(adminPassword, sessionSecret));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /\\n/);
  assert.equal(result.stdout, '');
});

test('rejects effective placeholders without printing their values', (t) => {
  const placeholder = 'pon-aqui-un-secreto-largo';
  const result = runValidator(
    t,
    effectiveValidatorPath,
    resolvedComposeConfig('pon-aqui-la-contrasena-real', placeholder)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /pon-aqui/);
  assert.equal(result.stdout, '');
});
