const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const validatorPath = path.join(__dirname, '..', 'scripts', 'validate-production-env.sh');

function validateEnv(t, contents) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'calendario-env-test-'));
  const envPath = path.join(directory, '.env');
  writeFileSync(envPath, contents);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; validate_production_env "$2"', '--', validatorPath, envPath],
    { encoding: 'utf8' }
  );
}

test('rejects exact example placeholders without printing their values', (t) => {
  const placeholder = 'pon-aqui-la-contrasena-real';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD=${placeholder}\nSESSION_SECRET=01234567890123456789012345678901\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.doesNotMatch(result.stderr, /pon-aqui/);
});

test('normalizes spaces, matching quotes, CRLF, and case before checking examples', (t) => {
  const result = validateEnv(
    t,
    'ADMIN_PASSWORD=  " PoN-aQuI-La-CoNtRaSeNa-ReAl "  \r\n'
      + "SESSION_SECRET='01234567890123456789012345678901'\r\n"
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.doesNotMatch(result.stderr, /pon-aqui/i);
});

test('accepts real values meeting both minimum lengths', (t) => {
  const result = validateEnv(
    t,
    'ADMIN_PASSWORD=12345678\nSESSION_SECRET=01234567890123456789012345678901\n'
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('rejects a short ADMIN_PASSWORD with an inline comment without printing its value', (t) => {
  const password = 'p7';
  const comment = 'this comment must not count toward the minimum length';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD=${password} # ${comment}\nSESSION_SECRET=01234567890123456789012345678901\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.doesNotMatch(result.stderr, new RegExp(`${password}|${comment}`));
});

test('rejects a SESSION_SECRET placeholder with an inline comment without printing it', (t) => {
  const placeholder = 'pon-aqui-un-secreto-largo';
  const comment = 'comment-padding-that-is-not-secret-length';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD=12345678\nSESSION_SECRET=${placeholder} # ${comment}\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, new RegExp(`${placeholder}|${comment}`));
});

test('rejects a short SESSION_SECRET with an inline comment without printing its value', (t) => {
  const secret = 's3c';
  const comment = 'this comment must not count toward the minimum length';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD=12345678\nSESSION_SECRET=${secret} # ${comment}\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, new RegExp(`${secret}|${comment}`));
});

test('strips comments from other variables before checking placeholders', (t) => {
  const placeholder = 'smtp.example.com';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD=12345678\nSESSION_SECRET=01234567890123456789012345678901\n`
      + `SMTP_HOST=${placeholder} # configured later\nSMTP_USER="usuario-smtp" # configured later\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMTP_HOST/);
  assert.match(result.stderr, /SMTP_USER/);
  assert.doesNotMatch(result.stderr, /smtp\.example\.com|usuario-smtp/);
});

test('accepts matching quoted secrets including a literal hash inside the quotes', (t) => {
  const result = validateEnv(
    t,
    'ADMIN_PASSWORD="correct horse # battery"\n'
      + "SESSION_SECRET='01234567890123456789012345678901#quoted'\n"
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('rejects an inline comment after a quoted security value without printing it', (t) => {
  const password = 'quoted-password-value';
  const comment = 'quoted-comment-value';
  const result = validateEnv(
    t,
    `ADMIN_PASSWORD="${password}" # ${comment}\nSESSION_SECRET=01234567890123456789012345678901\n`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.doesNotMatch(result.stderr, new RegExp(`${password}|${comment}`));
});

test('requires SESSION_SECRET and reports only its variable name', (t) => {
  const result = validateEnv(t, 'ADMIN_PASSWORD=12345678\n');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /12345678/);
});

test('rejects values shorter than the configured minimums', (t) => {
  const result = validateEnv(
    t,
    'ADMIN_PASSWORD=short\nSESSION_SECRET=0123456789012345678901234567890\n'
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.match(result.stderr, /SESSION_SECRET/);
  assert.doesNotMatch(result.stderr, /short|0123456789/);
});
