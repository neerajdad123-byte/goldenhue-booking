/* Can the owner get back in?

   The account is created once, from ADMIN_EMAIL and ADMIN_PASSWORD. Changing either
   and redeploying has to take the account over, or someone who forgets which address
   they used is locked out of their own salon with no way back in.

   Usage: node work/admin-takeover-test.js */
'use strict';
var path = require('path');
var fs = require('fs');
var { spawn } = require('child_process');

var PORT = 3051;
var DB = path.join(__dirname, 'takeover.db');
var ROOT = path.join(__dirname, '..');
var BASE = 'http://127.0.0.1:' + PORT;
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function start(env) {
  return spawn(process.execPath, [path.join(ROOT, 'outputs/demo/server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DB_FILE: DB, DATABASE_URL: '' }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
async function up() {
  for (var i = 0; i < 40; i += 1) {
    try { await (await fetch(BASE + '/health')).json(); return true; }
    catch (e) { await sleep(250); }
  }
  return false;
}
async function canSignIn(email, password) {
  var r = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ salonId: 'goldenhue', email: email, password: password })
  });
  return r.status === 200;
}

(async function () {
  [DB, DB + '-wal', DB + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

  /* First boot: the owner's original details. */
  var server = start({ ADMIN_EMAIL: 'owner@first.example', ADMIN_PASSWORD: 'first-password-1' });
  check('the server starts', await up());
  check('the first password works', await canSignIn('owner@first.example', 'first-password-1'));
  server.kill();
  await sleep(600);

  /* Redeploy with a different address and password. This is the case that locked
     people out: the account existed under the old address, and the lookup by email
     found nothing. */
  server = start({ ADMIN_EMAIL: 'owner@second.example', ADMIN_PASSWORD: 'second-password-2' });
  check('the server restarts', await up());
  check('the new address and password work', await canSignIn('owner@second.example', 'second-password-2'));
  check('the old password no longer works', !(await canSignIn('owner@first.example', 'first-password-1')));
  check('the old address no longer works', !(await canSignIn('owner@first.example', 'second-password-2')));
  server.kill();
  await sleep(600);

  /* And a third time, to be sure it is repeatable rather than a one-off. */
  server = start({ ADMIN_EMAIL: 'owner@third.example', ADMIN_PASSWORD: 'third-password-3' });
  check('the server restarts again', await up());
  check('the third set of details works', await canSignIn('owner@third.example', 'third-password-3'));
  check('and only those', !(await canSignIn('owner@second.example', 'second-password-2')));

  /* A no-op redeploy with unchanged details must not churn the account. */
  server.kill();
  await sleep(600);
  server = start({ ADMIN_EMAIL: 'owner@third.example', ADMIN_PASSWORD: 'third-password-3' });
  check('the server restarts once more', await up());
  check('unchanged details still work', await canSignIn('owner@third.example', 'third-password-3'));

  server.kill();
  await sleep(300);
  [DB, DB + '-wal', DB + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
