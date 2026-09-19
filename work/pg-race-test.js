/* The Postgres guard, tested against real Postgres semantics.

   The deployment runs on a managed Postgres, where the guarantee is an exclusion
   constraint rather than a transaction. This starts a real Postgres (PGlite,
   compiled to WebAssembly, served over its wire protocol) and points two server
   processes at it, which is exactly the shape of the deployment: more than one
   instance, one database.

   Usage: node work/pg-race-test.js */
'use strict';
var path = require('path');
var { spawn } = require('child_process');
var { PGlite } = require('@electric-sql/pglite');
var { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

var ROOT = path.join(__dirname, '..');
var PG_PORT = 55432;
var PORTS = [3021, 3022];
var N = 12;
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function url() { return 'postgres://postgres:postgres@127.0.0.1:' + PG_PORT + '/postgres'; }

function startServer(port) {
  var p = spawn(process.execPath, [path.join(ROOT, 'outputs/demo/server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port), DATABASE_URL: url(),
      ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'test-password-123'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stderr.on('data', function (d) { console.error('  server ' + port + ': ' + String(d).trim().split('\n')[0]); });
  return p;
}
async function waitUp(port) {
  for (var i = 0; i < 60; i += 1) {
    try { await (await fetch('http://127.0.0.1:' + port + '/health')).json(); return true; }
    catch (e) { await sleep(400); }
  }
  return false;
}
async function get(port, p) { return (await fetch('http://127.0.0.1:' + port + p)).json(); }

(async function () {
  var db = new PGlite();
  /* maxConnections defaults to 1, which terminates the moment a real connection
     pool opens its second socket. A hosted Postgres has no such limit; this is
     only the test harness. */
  var server = new PGLiteSocketServer({ db: db, port: PG_PORT, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  console.log('postgres listening on ' + PG_PORT);

  /* Started one at a time. PGlite's socket server accepts a limited number of
     connections at once, and two servers booting simultaneously reset each other.
     A real Postgres does not care, but the test should not be flaky. */
  var procs = [];
  var up = [];
  for (var p of PORTS) {
    procs.push(startServer(p));
    up.push(await waitUp(p));
    await sleep(300);
  }
  check('two servers boot against one Postgres', up.every(Boolean), JSON.stringify(up));
  if (!up.every(Boolean)) { throw new Error('servers did not start'); }

  try {
    /* Search forward for a day the stylist actually works, rather than assuming an
       offset: a fixed one landed on their day off and read as a broken system. */
    var day = null, target = null;
    for (var d = 1; d <= 20 && !target; d += 1) {
      var probeDay = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
      var probe = await get(PORTS[0], '/api/availability?salon=goldenhue&service=gh-colour&staff=ramesh&date=' + probeDay);
      if (probe.slots && probe.slots.length) { day = probeDay; target = probe.slots[0]; }
    }
    check('a slot is offered on a day the stylist works', !!target, 'nothing free in three weeks');
    if (!target) { throw new Error('no availability to test'); }

    /* two processes, one slot, all at once */
    var attempts = [];
    for (var i = 0; i < N * PORTS.length; i += 1) {
      attempts.push(fetch('http://127.0.0.1:' + PORTS[i % PORTS.length] + '/api/book', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          salonId: 'goldenhue', serviceId: 'gh-colour', staffId: 'ramesh', startISO: target.startISO,
          customer: { name: 'Racer ' + i, phone: '9000000' + String(100 + i) }
        })
      }).then(function (r) { return r.status; }));
    }
    var codes = await Promise.all(attempts);
    var created = codes.filter(function (c) { return c === 201; }).length;
    var refused = codes.filter(function (c) { return c === 409; }).length;
    check(N * 2 + ' simultaneous bookings across two processes create exactly one',
      created === 1, created + ' created, ' + refused + ' refused, other ' + (N * 2 - created - refused));
    check('the database holds one row for that time',
      (await get(PORTS[0], '/api/appointments?salon=goldenhue&date=' + day))
        .appointments.filter(function (a) { return a.startMin === target.startMin; }).length === 1);

    /* A cancelled booking must not keep blocking its time. This is the half of the
       guard that is easy to get wrong: the overlap check has to ignore rows that no
       longer hold a chair. */
    var freeDay = null, freeSlot = null;
    for (var f = 1; f <= 20 && !freeSlot; f += 1) {
      var fd = new Date(Date.now() + f * 86400000).toISOString().slice(0, 10);
      var fs = await get(PORTS[0], '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + fd);
      if (fs.slots && fs.slots.length) { freeDay = fd; freeSlot = fs.slots[0]; }
    }
    check('a second day is available for the cancellation check', !!freeSlot);
    await db.query(
      `INSERT INTO appointment (id, ref, salon_id, staff_id, service_id, customer_name,
         day, start_min, end_min, start_iso, end_iso, status, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now(),'cancelled',1000)`,
      ['cancelled-one', 'XX-CANCEL', 'goldenhue', 'ramesh', 'gh-haircut', 'Cancelled Booking',
        freeDay, freeSlot.startMin, freeSlot.startMin + 45]);
    var stillFree = await get(PORTS[0], '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + freeDay);
    check('a cancelled booking stops blocking its time',
      stillFree.slots.some(function (s) { return s.startMin === freeSlot.startMin; }),
      'slot at ' + freeSlot.startMin + ' is still blocked');

    /* A restart must not lose anything, which is the whole point of moving the
       database off the host. */
    procs[0].kill();
    await sleep(600);
    procs[0] = startServer(PORTS[0]);
    check('the restarted server comes back', await waitUp(PORTS[0]));
    check('and still sees the booking',
      (await get(PORTS[0], '/api/appointments?salon=goldenhue&date=' + day))
        .appointments.filter(function (a) { return a.startMin === target.startMin && a.status !== 'cancelled'; }).length === 1);
  } finally {
    procs.forEach(function (p) { try { p.kill(); } catch (e) {} });
    await sleep(300);
    try { await server.close(); } catch (e) {}
    try { await db.close(); } catch (e) {}
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
