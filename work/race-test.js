/* The test that actually proves the guard.

   Node is single-threaded and node:sqlite is synchronous, so firing parallel
   requests at ONE server cannot interleave a check with an insert. A test like
   that passes even if the transaction is deleted, which makes it worthless.

   Two server processes sharing one database file is what the transaction is for,
   and it is also how this would run behind a load balancer. This starts two, fires
   simultaneous bookings at the same slot through both, and asserts that exactly
   one appointment exists afterwards.

   Usage: node work/race-test.js */
'use strict';
var fs = require('fs');
var path = require('path');
var { spawn } = require('child_process');

var ROOT = path.join(__dirname, '..');
var DB = path.join(__dirname, 'race.db');
var PORTS = [3011, 3012];
var N = 12;                    /* per server, so 24 in flight at once */
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function get(port, p) {
  var r = await fetch('http://127.0.0.1:' + port + p);
  return r.json();
}
async function book(port, body) {
  var r = await fetch('http://127.0.0.1:' + port + '/api/book', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.status;
}

(async function () {
  [DB, DB + '-wal', DB + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });

  var servers = PORTS.map(function (port) {
    return spawn(process.execPath, [path.join(ROOT, 'outputs/demo/server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port), DB_FILE: DB }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  });
  servers.forEach(function (s) {
    s.stderr.on('data', function (d) { console.error('server: ' + String(d).trim()); });
  });

  /* wait for both to answer */
  for (var attempt = 0; attempt < 40; attempt += 1) {
    try { await Promise.all(PORTS.map(function (p) { return get(p, '/health'); })); break; }
    catch (e) { await sleep(250); }
  }
  var health = await Promise.all(PORTS.map(function (p) { return get(p, '/health'); }));
  check('two servers are up on one database', health.every(function (h) { return h.ok; }), JSON.stringify(health));

  try {
    /* a day far enough out that the seeded demo bookings are not in the way */
    var day = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    var slots = await get(PORTS[0], '/api/availability?salon=goldenhue&service=gh-colour&staff=ramesh&date=' + day);
    check('there is a slot to fight over', slots.slots && slots.slots.length > 0, 'none offered on ' + day);
    var target = slots.slots[0];

    /* every request at once, split across both processes */
    var attempts = [];
    for (var i = 0; i < N * PORTS.length; i += 1) {
      var port = PORTS[i % PORTS.length];
      attempts.push(book(port, {
        salonId: 'goldenhue', serviceId: 'gh-colour', staffId: 'ramesh', startISO: target.startISO,
        customer: { name: 'Racer ' + i, phone: '9000000' + String(100 + i) }
      }));
    }
    var codes = await Promise.all(attempts);
    var created = codes.filter(function (c) { return c === 201; }).length;
    var refused = codes.filter(function (c) { return c === 409; }).length;
    check(N * 2 + ' simultaneous bookings across two processes create exactly one',
      created === 1, created + ' created, ' + refused + ' refused, other ' + (N * 2 - created - refused));
    check('everyone else is told the slot has gone', refused === N * 2 - 1, refused + ' refusals');

    /* and the database agrees */
    var stored = await get(PORTS[0], '/api/appointments?salon=goldenhue&date=' + day);
    var atSlot = stored.appointments.filter(function (a) { return a.startMin === target.startMin; });
    check('one row exists for that time', atSlot.length === 1, atSlot.length + ' rows');
    check('the other server sees the same single row', (await get(PORTS[1], '/api/appointments?salon=goldenhue&date=' + day))
      .appointments.filter(function (a) { return a.startMin === target.startMin; }).length === 1);

    /* the buffer still blocks the slot behind it */
    var after = await get(PORTS[0], '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day);
    var afterOther = await get(PORTS[1], '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day);
    /* If the two servers disagree, the cause is each one caching bookings in
       memory rather than reading them back. */
    var minsA = after.slots.map(function (s) { return s.startMin; }).join(',');
    var minsB = afterOther.slots.map(function (s) { return s.startMin; }).join(',');
    check('both servers offer the same slots', minsA === minsB,
      'A: ' + minsA + ' | B: ' + minsB);
    console.log('     winner was at ' + target.startMin + ' (135 minutes including turnaround)');
    var clash = after.slots.filter(function (s) {
      var m = new Date(s.startISO).getTime();
      var taken = new Date(target.startISO).getTime();
      return m < taken + 135 * 60000 && taken < m + 55 * 60000;
    });
    check('nothing overlapping the winner is left on offer', clash.length === 0, clash.length + ' overlapping slots');
  } finally {
    servers.forEach(function (s) { try { s.kill(); } catch (e) {} });
    await sleep(400);
    [DB, DB + '-wal', DB + '-shm'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
