const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repositoryRoot = path.join(__dirname, '..');
const guardPath = path.join(repositoryRoot, 'scripts', 'assert-deploy-paths.sh');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'deploy.yml');

function createGitRepository(t, files) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'calendario-deploy-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  const init = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  runGit('config', 'user.name', 'deploy guard test');
  runGit('config', 'user.email', 'deploy-guard-test@example.invalid');

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(directory, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }

  runGit('add', '--all');
  runGit('commit', '--quiet', '-m', 'deployment guard fixture');

  return { directory, sha: runGit('rev-parse', 'HEAD') };
}

function checkTrackedPaths(repository, source) {
  return spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; cd "$2"; assert_no_protected_tracked_paths "$3" "$4"',
      '--',
      guardPath,
      repository.directory,
      source,
      repository.sha
    ],
    { encoding: 'utf8' }
  );
}

function remoteDeploymentScript() {
  const workflow = readFileSync(workflowPath, 'utf8');
  const remote = workflow.match(/cat <<'REMOTE'\n([\s\S]*?)\n\s*REMOTE\n/);

  assert.ok(remote, 'the remote deployment heredoc must remain present');
  assert.match(workflow, /cat scripts\/assert-deploy-paths\.sh[\s\S]*?cat <<'REMOTE'/);
  return remote[1];
}

test('allows the data/.gitkeep exception in the current index and target tree', (t) => {
  const repository = createGitRepository(t, { 'data/.gitkeep': '' });

  assert.equal(checkTrackedPaths(repository, 'current').status, 0);
  assert.equal(checkTrackedPaths(repository, 'target').status, 0);
});

test('rejects a tracked .env in the current checkout without exposing its contents', (t) => {
  const protectedValue = 'fixture-env-content-should-not-be-printed';
  const repository = createGitRepository(t, { '.env': `TOKEN=${protectedValue}\n` });
  const result = checkTrackedPaths(repository, 'current');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /\.env|fixture-env-content/);
});

test('rejects a tracked .env child path in the current checkout', (t) => {
  const protectedValue = 'fixture-env-child-content-should-not-be-printed';
  const repository = createGitRepository(t, { '.env/child': protectedValue });
  const result = checkTrackedPaths(repository, 'current');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /\.env|fixture-env-child-content/);
});

test('rejects a tracked data file in the current checkout', (t) => {
  const repository = createGitRepository(t, { 'data/visibility.json': '{"private":"fixture"}\n' });
  const result = checkTrackedPaths(repository, 'current');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /data\/visibility\.json|fixture/);
});

test('rejects the exact tracked data path in the current checkout', (t) => {
  const repository = createGitRepository(t, { data: 'fixture-data-content-should-not-be-printed' });
  const result = checkTrackedPaths(repository, 'current');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /fixture-data-content/);
});

test('rejects a tracked .env in the fetched target tree without exposing its contents', (t) => {
  const protectedValue = 'target-env-content-should-not-be-printed';
  const repository = createGitRepository(t, { '.env': `TOKEN=${protectedValue}\n` });
  const result = checkTrackedPaths(repository, 'target');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /\.env|target-env-content/);
});

test('rejects a tracked .env child path in the fetched target tree', (t) => {
  const protectedValue = 'target-env-child-content-should-not-be-printed';
  const repository = createGitRepository(t, { '.env/child': protectedValue });
  const result = checkTrackedPaths(repository, 'target');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /\.env|target-env-child-content/);
});

test('rejects a tracked data file in the fetched target tree', (t) => {
  const repository = createGitRepository(t, { 'data/scheduled-mails.json': '{"private":"fixture"}\n' });
  const result = checkTrackedPaths(repository, 'target');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /data\/scheduled-mails\.json|fixture/);
});

test('rejects the exact tracked data path in the fetched target tree', (t) => {
  const repository = createGitRepository(t, { data: 'target-data-content-should-not-be-printed' });
  const result = checkTrackedPaths(repository, 'target');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /rutas protegidas versionadas/);
  assert.doesNotMatch(result.stderr, /target-data-content/);
});

test('checks protected paths before force checkout and retains exact-SHA deployment flow', () => {
  const remote = remoteDeploymentScript();
  const currentCheck = remote.indexOf('assert_no_protected_tracked_paths current');
  const fetch = remote.indexOf('git fetch --quiet origin "$GITHUB_SHA"');
  const targetCheck = remote.indexOf('assert_no_protected_tracked_paths target "$GITHUB_SHA"');
  const checkout = remote.indexOf('git checkout --detach --force "$GITHUB_SHA"');
  const shaVerification = remote.indexOf('git rev-parse HEAD');
  const clean = remote.indexOf("git clean -fd -e .env -e data/ -e 'data/**'");
  const composeConfig = remote.indexOf('docker compose -f docker-compose.prod.yml config --format json');
  const effectiveSecretsValidation = remote.indexOf('node scripts/validate-effective-compose-secrets.js "$COMPOSE_CONFIG"');
  const composeUp = remote.indexOf('docker compose -f docker-compose.prod.yml up -d --build --remove-orphans');

  assert.ok(currentCheck >= 0 && currentCheck < fetch);
  assert.ok(fetch < targetCheck && targetCheck < checkout);
  assert.ok(checkout < shaVerification && shaVerification < clean);
  assert.match(remote, /validate_production_env \.env/);
  assert.match(remote, /chmod 600 \.env/);
  assert.match(remote, /trap 'rm -f -- "\$COMPOSE_CONFIG"/);
  assert.match(remote, /chmod 600 "\$COMPOSE_CONFIG"/);
  assert.match(remote, /config --format json >"\$COMPOSE_CONFIG" 2>\/dev\/null/);
  assert.ok(clean < composeConfig && composeConfig < effectiveSecretsValidation);
  assert.ok(effectiveSecretsValidation < composeUp);
  assert.match(remote, /docker compose -f docker-compose\.prod\.yml up -d --build --remove-orphans/);
  assert.match(remote, /http:\/\/127\.0\.0\.1:8099\/api\/config/);
  assert.match(remote, /docker compose -f docker-compose\.prod\.yml ps/);
});

test('embedded remote deployment script has valid Bash syntax', () => {
  const result = spawnSync('bash', ['-n', '-c', remoteDeploymentScript()], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
});
