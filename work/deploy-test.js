/* Does a fresh clone actually run?

   This reproduces what the host does and nothing else: copy the files that are in
   git, run the install command from the deploy config, then start the app against a
   Postgres and see whether it answers.

   It exists because the first deploy failed on a dependency that was installed
   locally but never declared where the host would install it. Testing the app is
   not the same as testing the deploy, and only one of those was being done.

   Usage: node work/deploy-test.js */
'use strict';
var fs = require('fs');
var path = require('path');
var { execFileSync, spawn } = require('child_process');
var { PGlite } = require('@electric-sql/pglite');
var { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

var ROOT = path.join(__dirname, '..');
var SIM = path.join(__dirname, 'deploy-sim');
var PG_PORT = 55440;
var APP_PORT = 3041;
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  /* 1. A clean copy of exactly what is committed. Anything untracked is excluded on
        purpose: if it is not in the repository, the host does not get it. */
  fs.rmSync(SIM, { recursive: true, force: true });
  fs.mkdirSync(SIM, { recursive: true });
  var tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  var copied = 0;
  tracked.forEach(function (rel) {
    var from = path.join(ROOT, rel);
    var to = path.join(SIM, rel);
    if (!fs.existsSync(from)) { return; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  });
  check('the tracked files were copied', copied > 50, copied + ' files');
  check('and node_modules was not among them', !fs.existsSync(path.join(SIM, 'node_modules')));

  /* 2. The install the deploy config runs, in the directory it runs it in. */
  var appDir = path.join(SIM, 'outputs', 'demo');
  var pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  console.log('     the app declares: ' + JSON.stringify(pkg.dependencies));

  var installed = true, installOut = '';
  try {
    /* npm on Windows is a shell script, so it is run through the shell. */
    installOut = execFileSync('npm install --omit=dev --no-audit --no-fund', {
      cwd: appDir, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    installed = false;
    installOut = String(e.stdout || '') + String(e.stderr || '');
  }
  check('the install succeeds in a clean checkout', installed, installOut.slice(-200));
  check('the pg driver is present after installing', fs.existsSync(path.join(appDir, 'node_modules', 'pg')));

  /* 3. Start it against a Postgres, as the deployment does. */
  var db = new PGlite();
  var pgServer = new PGLiteSocketServer({ db: db, port: PG_PORT, host: '127.0.0.1', maxConnections: 16 });
  await pgServer.start();

  var url = 'postgres://postgres:postgres@127.0.0.1:' + PG_PORT + '/postgres';
  var app = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), DATABASE_URL: url, NODE_ENV: 'production',
      ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'deploy-test-password'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  var log = '';
  app.stdout.on('data', function (d) { log += String(d); });
  app.stderr.on('data', function (d) { log += String(d); });

  var up = false;
  for (var i = 0; i < 90; i += 1) {
    try { await (await fetch('http://127.0.0.1:' + APP_PORT + '/health')).json(); up = true; break; }
    catch (e) { await sleep(500); }
  }
  check('the app boots in a clean checkout against Postgres', up,
    log.split('\n').filter(function (l) { return l && l.indexOf('Warning') < 0; }).slice(-3).join(' | '));

  if (up) {
    var health = await (await fetch('http://127.0.0.1:' + APP_PORT + '/health')).json();
    check('it reports its appointments', typeof health.appointments === 'number', JSON.stringify(health));
    var page = await fetch('http://127.0.0.1:' + APP_PORT + '/');
    /* The salon name is filled in by the page's own script, so the static HTML is
       checked for its markup instead. */
    var html = await page.text();
    check('the booking page is served', page.status === 200 && html.indexOf('serviceList') >= 0,
      'HTTP ' + page.status + ', ' + html.length + ' bytes');
    var assets = await Promise.all(['styles.css', 'engine.js', 'app.js', 'data.js'].map(function (f) {
      return fetch('http://127.0.0.1:' + APP_PORT + '/' + f).then(function (r) { return r.status; });
    }));
    check('and every asset it needs is there', assets.every(function (s) { return s === 200; }), JSON.stringify(assets));
    var admin = await fetch('http://127.0.0.1:' + APP_PORT + '/admin', { redirect: 'manual' });
    check('the front desk is behind a sign-in', admin.status === 302, String(admin.status));
  }

  app.kill();
  await sleep(300);
  try { await pgServer.close(); } catch (e) {}
  try { await db.close(); } catch (e) {}
  fs.rmSync(SIM, { recursive: true, force: true });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
