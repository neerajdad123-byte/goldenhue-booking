/* Does a booking survive the server being replaced?

   This is the whole reason the deploy uses a disk. On a free Render instance the
   filesystem is ephemeral, so the same sequence would come back empty and every
   booking would vanish on the next spin-down.

   Usage: node work/persist-test.js [port] [dbFile] */
'use strict';
var { spawn } = require('child_process');
var path = require('path');

var PORT = Number(process.argv[2] || 10000);
var DB = process.argv[3] || path.join(__dirname, 'persist.db');
var ROOT = path.join(__dirname, '..');
var BASE = 'http://127.0.0.1:' + PORT;
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function start() {
  return spawn(process.execPath, [path.join(ROOT, 'outputs/demo/server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DB_FILE: DB,
      ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'test-password-123'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitUp() {
  for (var i = 0; i < 40; i += 1) {
    try { await (await fetch(BASE + '/health')).json(); return true; }
    catch (e) { await sleep(250); }
  }
  return false;
}

(async function () {
  var server = start();
  if (!await waitUp()) { throw new Error('server never came up'); }

  var day = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  var slots = await (await fetch(BASE + '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day)).json();
  check('a slot is free to begin with', slots.slots && slots.slots.length > 0, 'none on ' + day);
  var target = slots.slots[0];

  var booked = await (await fetch(BASE + '/api/book', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', startISO: target.startISO,
      customer: { name: 'Persistence Test', phone: '9876543210' }
    })
  })).json();
  check('the booking is accepted', /^GH-/.test(booked.ref || ''), JSON.stringify(booked).slice(0, 90));

  /* The interesting part: replace the process entirely. */
  server.kill();
  await sleep(700);
  server = start();
  if (!await waitUp()) { throw new Error('server did not come back'); }

  var after = await (await fetch(BASE + '/api/appointments?salon=goldenhue&date=' + day)).json();
  var found = after.appointments.filter(function (a) { return a.ref === booked.ref; })[0];
  check('the booking survives the restart', !!found,
    found ? '' : 'gone. ' + after.appointments.length + ' appointments remain');
  if (found) {
    check('with its time intact', found.startMin === booked.startMin, found.startMin + ' vs ' + booked.startMin);
    check('and its customer intact', found.customerName === 'Persistence Test', found.customerName);
  }

  /* And availability still refuses it, so the guard survived too. */
  var again = await (await fetch(BASE + '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day)).json();
  check('the booked slot is still not on offer',
    !again.slots.some(function (s) { return s.startISO === target.startISO; }));

  /* The session secret is stored, so a restart must not sign the owner out. */
  var login = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ salonId: 'goldenhue', email: 'owner@example.com', password: 'test-password-123' })
  });
  var cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  server.kill();
  await sleep(700);
  server = start();
  await waitUp();
  var stillValid = await fetch(BASE + '/api/admin/config?salon=goldenhue', { headers: { cookie: cookie } });
  check('a signed-in owner stays signed in across a restart', stillValid.status === 200, String(stillValid.status));

  server.kill();
  await sleep(300);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
