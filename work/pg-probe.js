/* What does the server think the staff hours are, when they came from Postgres?
   Usage: node work/pg-probe.js */
'use strict';
var path = require('path');
var { spawn } = require('child_process');
var { PGlite } = require('@electric-sql/pglite');
var { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

var ROOT = path.join(__dirname, '..');
var PG_PORT = 55433, PORT = 3031;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  var db = new PGlite();
  var server = new PGLiteSocketServer({ db: db, port: PG_PORT, host: '127.0.0.1', maxConnections: 16 });
  await server.start();

  var p = spawn(process.execPath, [path.join(ROOT, 'outputs/demo/server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:' + PG_PORT + '/postgres',
      ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'test-password-123'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', function (d) { console.log('  ' + String(d).trim()); });
  p.stderr.on('data', function (d) { console.log('  ERR ' + String(d).trim().split('\n')[0]); });

  for (var i = 0; i < 40; i += 1) {
    try { await (await fetch('http://127.0.0.1:' + PORT + '/health')).json(); break; }
    catch (e) { await sleep(400); }
  }

  var cat = await (await fetch('http://127.0.0.1:' + PORT + '/api/catalog')).json();
  console.log('staff hours from the catalogue:');
  cat.staff.filter(function (s) { return s.salonId === 'goldenhue'; }).forEach(function (s) {
    console.log('  ' + s.id + ': ' + JSON.stringify(s.hours));
  });

  var rows = await db.query('SELECT staff_id, weekday, start_min, end_min FROM staff_hours ORDER BY staff_id, weekday LIMIT 10');
  console.log('staff_hours rows in the database: ' + rows.rows.length);
  rows.rows.forEach(function (r) { console.log('  ' + r.staff_id + ' wd' + r.weekday + ' ' + r.start_min + '-' + r.end_min); });

  var day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  var diag = await (await fetch('http://127.0.0.1:' + PORT + '/api/diary?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day)).json();
  console.log('diary on ' + day + ' (' + new Date(day + 'T12:00:00').getDay() + '):');
  (diag.lanes || []).forEach(function (l) {
    console.log('  ' + l.staff.id + ' windows=' + JSON.stringify(l.windows) + ' busy=' + JSON.stringify(l.busy) + ' free=' + JSON.stringify(l.free));
  });
  var svc = cat.services.filter(function (s) { return s.id === 'gh-haircut'; })[0];
  console.log('  service: ' + JSON.stringify({ d: svc.durationMin, b: svc.bufferMin, active: svc.active }));

  /* Rebuild a state from exactly what the server sent, and ask the engine the same
     question. If this produces windows, the data is fine and the server's own state
     is what differs. */
  var GH = require(path.join(ROOT, 'outputs/demo/engine.js'));
  var built = GH.createState({
    salons: cat.salons, services: cat.services, staff: cat.staff,
    salonsClosed: [], appointments: []
  });
  var r2 = GH.getStaff(built, 'ramesh');
  console.log('  engine: ramesh.hoursMin[1]=' + JSON.stringify(r2.hoursMin[1]) +
    ' breaks=' + JSON.stringify(r2.breaksMin));
  console.log('  engine windows for ' + day + '=' +
    JSON.stringify(GH.staffWindows(r2, GH.getSalon(built, 'goldenhue'), day)));

  var res = await fetch('http://127.0.0.1:' + PORT + '/api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + day);
  console.log('availability: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));

  p.kill();
  await sleep(200);
  try { await server.close(); } catch (e) {}
  try { await db.close(); } catch (e) {}
  process.exit(0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
