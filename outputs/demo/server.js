/* Goldenhue booking server.

   No dependencies: Node's own http, and node:sqlite for the database. The demo
   folder it sits in is still a working static page; when this server is running,
   the same page talks to it and the bookings become real.

   The one decision that matters is in createBooking(): the overlap check and the
   insert happen inside a single IMMEDIATE transaction, so two customers clicking
   the same slot cannot both succeed. That is the database doing the work, not the
   application, which is why it holds under concurrent requests.

   Run: node outputs/demo/server.js        (PORT env to change, default 3000) */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var { DatabaseSync } = require('node:sqlite');
var GH = require('./engine.js');
var DATA = require('./data.js');

var ROOT = __dirname;
var PORT = Number(process.env.PORT || 3000);
var DB_FILE = process.env.DB_FILE || path.join(ROOT, 'goldenhue.db');

/* The rules live in engine.js, which is the same file the browser loads. The
   server owns the clock and the data; the engine owns the arithmetic. */
var state = GH.createState(DATA);

var db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS appointment (
    id           TEXT PRIMARY KEY,
    ref          TEXT NOT NULL UNIQUE,
    salon_id     TEXT NOT NULL,
    staff_id     TEXT NOT NULL,
    service_id   TEXT NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    day          TEXT NOT NULL,
    start_min    INTEGER NOT NULL,
    end_min      INTEGER NOT NULL,
    start_iso    TEXT NOT NULL,
    end_iso      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'booked',
    price        INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS appointment_lookup
    ON appointment (salon_id, staff_id, day, status);
`);

var ins = db.prepare(`INSERT INTO appointment
  (id, ref, salon_id, staff_id, service_id, customer_name, customer_phone, customer_email,
   note, day, start_min, end_min, start_iso, end_iso, status, price, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

var byDay = db.prepare(`SELECT * FROM appointment
  WHERE salon_id = ? AND day = ? AND status IN ('pending','booked','confirmed')`);

var byRef = db.prepare('SELECT * FROM appointment WHERE ref = ?');

/* The guard. Half-open: 10:00-12:00 and 12:00-12:30 do not clash, 11:59 does. */
var clash = db.prepare(`SELECT ref FROM appointment
  WHERE salon_id = ? AND staff_id = ? AND day = ?
    AND status IN ('pending','booked','confirmed')
    AND start_min < ? AND ? < end_min
  LIMIT 1`);

/* ---------- mirror the database into the engine's shape ---------- */

function rowToAppointment(r) {
  return {
    id: r.id, ref: r.ref, salonId: r.salon_id, staffId: r.staff_id, serviceId: r.service_id,
    customerName: r.customer_name, customerPhone: r.customer_phone, customerEmail: r.customer_email,
    note: r.note, day: r.day, status: r.status, price: r.price,
    startsAt: new Date(r.start_iso), endsAt: new Date(r.end_iso),
    bufferUntil: new Date(r.end_iso), startMin: r.start_min, endMin: r.end_min
  };
}

function loadAppointments() {
  var rows = db.prepare(`SELECT * FROM appointment
    WHERE status IN ('pending','booked','confirmed') AND day >= ?`).all(GH.todayYmd());
  state.appointments = rows.map(rowToAppointment);
}

/* ---------- seeding ---------- */

function seedIfEmpty() {
  var count = db.prepare('SELECT COUNT(*) AS n FROM appointment').get().n;
  if (count > 0) { return; }
  var seeded = GH.createState(DATA).appointments;
  var tx = db.prepare(`INSERT INTO appointment
    (id, ref, salon_id, staff_id, service_id, customer_name, customer_phone, customer_email,
     note, day, start_min, end_min, start_iso, end_iso, status, price, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (var a of seeded) {
    var startMin = a.startsAt.getHours() * 60 + a.startsAt.getMinutes();
    var endMin = a.bufferUntil.getHours() * 60 + a.bufferUntil.getMinutes();
    tx.run(a.id, a.ref, a.salonId, a.staffId, a.serviceId, a.customerName, '', '',
      'Seeded example booking', a.day, startMin, endMin,
      a.startsAt.toISOString(), a.bufferUntil.toISOString(), 'booked', a.price, new Date().toISOString());
  }
  console.log('seeded ' + seeded.length + ' example bookings');
}

/* ---------- booking, the atomic bit ---------- */

function makeRef() {
  var chars = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
  for (var i = 0; i < 6; i += 1) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return 'GH-' + out;
}

function createBooking(input) {
  var salon = GH.getSalon(state, input.salonId);
  var svc = GH.getService(state, input.serviceId);
  if (!salon || !svc) { return { status: 400, body: { error: 'Unknown salon or service' } }; }
  if (!input.customer || !String(input.customer.name || '').trim()) {
    return { status: 400, body: { error: 'A name is required' } };
  }

  var start = new Date(input.startISO);
  if (isNaN(start.getTime())) { return { status: 400, body: { error: 'Bad start time' } }; }
  var day = GH.ymd(start);
  var startMin = start.getHours() * 60 + start.getMinutes();
  var endMin = startMin + svc.durationMin + svc.bufferMin;

  /* who could take it: the requested stylist, or anyone free at that minute */
  var candidates = input.staffId
    ? [GH.getStaff(state, input.staffId)].filter(Boolean)
    : GH.eligibleStaff(state, salon.id, svc.id);
  if (input.preferStaffId) {
    candidates = candidates.slice().sort(function (a, b) {
      return (b.id === input.preferStaffId ? 1 : 0) - (a.id === input.preferStaffId ? 1 : 0);
    });
  }
  var capable = {};
  GH.eligibleStaff(state, salon.id, svc.id).forEach(function (s) { capable[s.id] = 1; });
  candidates = candidates.filter(function (s) { return capable[s.id]; });
  if (!candidates.length) { return { status: 400, body: { error: 'No stylist can take this service' } }; }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (var st of candidates) {
      if (!fitsShift(st, salon, day, startMin, endMin)) { continue; }
      var taken = clash.get(salon.id, st.id, day, endMin, startMin);
      if (taken) { continue; }

      var appt = {
        id: 'appt-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        ref: makeRef(), salonId: salon.id, staffId: st.id, serviceId: svc.id,
        customerName: String(input.customer.name).trim(),
        customerPhone: String(input.customer.phone || ''),
        customerEmail: String(input.customer.email || ''),
        note: String(input.customer.note || ''),
        day: day, startMin: startMin, endMin: endMin,
        status: 'booked', price: svc.price
      };
      var endAt = new Date(start.getTime() + (endMin - startMin) * 60000);
      ins.run(appt.id, appt.ref, appt.salonId, appt.staffId, appt.serviceId,
        appt.customerName, appt.customerPhone, appt.customerEmail, appt.note,
        day, startMin, endMin, start.toISOString(), endAt.toISOString(),
        'booked', svc.price, new Date().toISOString());
      db.exec('COMMIT');

      var stored = rowToAppointment(byRef.get(appt.ref));
      state.appointments.push(stored);
      broadcast(salon.id, { type: 'booked', day: day, staffId: st.id, startMin: startMin, ref: appt.ref });
      return { status: 201, body: {
        ref: appt.ref, id: appt.id, salonId: salon.id, staffId: st.id, staffName: st.name,
        serviceId: svc.id, serviceName: svc.name, day: day, startMin: startMin, endMin: endMin,
        price: svc.price, startsAt: start.toISOString(), endsAt: endAt.toISOString()
      } };
    }
    db.exec('ROLLBACK');
    return { status: 409, body: {
      error: 'Slot taken',
      message: GH.SLOT_TAKEN_MESSAGE
    } };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (ignored) { /* the transaction is already gone */ }
    throw e;
  }
}

/* Inside the shift, on a day the stylist actually works, after the lead time. */
function fitsShift(staff, salon, day, startMin, endMin) {
  var windows = GH.staffWindows(staff, salon, day);
  var inside = windows.some(function (w) { return w.start <= startMin && w.end >= endMin; });
  if (!inside) { return false; }
  var now = new Date();
  if (day === GH.todayYmd()) {
    var mins = now.getHours() * 60 + now.getMinutes();
    if (startMin < mins + salon.leadTimeMin) { return false; }
  }
  return true;
}

function cancelBooking(ref) {
  var row = byRef.get(ref);
  if (!row) { return { status: 404, body: { error: 'No such booking' } }; }
  if (row.status === 'cancelled') { return { status: 200, body: { ref: ref, status: 'cancelled' } }; }
  db.prepare('UPDATE appointment SET status = ? WHERE ref = ?').run('cancelled', ref);
  state.appointments = state.appointments.filter(function (a) { return a.ref !== ref; });
  broadcast(row.salon_id, { type: 'cancelled', day: row.day, staffId: row.staff_id, startMin: row.start_min, ref: ref });
  return { status: 200, body: { ref: ref, status: 'cancelled' } };
}

/* ---------- live updates ---------- */

var listeners = new Map();

function broadcast(salonId, payload) {
  var set = listeners.get(salonId);
  if (!set) { return; }
  var line = 'data: ' + JSON.stringify(payload) + '\n\n';
  set.forEach(function (res) {
    try { res.write(line); } catch (e) { set.delete(res); }
  });
}

/* ---------- config for the page ---------- */

function publicConfig() {
  return {
    now: new Date().toISOString(),
    salons: state.salons.map(function (s) {
      return {
        id: s.id, name: s.name, tagline: s.tagline, address: s.address, phone: s.phone,
        headline: s.headline, sub: s.sub, reviews: s.reviews, cover: s.cover, gallery: s.gallery,
        brand: s.brand, slotStepMin: s.slotStepMin, leadTimeMin: s.leadTimeMin,
        horizonDays: s.horizonDays, cancellationHours: s.cancellationHours,
        weekly: s.hoursMin.map(function (w) { return w; }),
        closed: s.closed
      };
    }),
    services: state.services,
    staff: state.staff.map(function (s) {
      return {
        id: s.id, salonId: s.salonId, name: s.name, title: s.title, bio: s.bio,
        services: s.services, photo: s.photo || null,
        hours: s.hoursMin, breaks: s.breaksMin,
        exceptions: s.exceptions.map(function (ex) {
          return { date: ex.date, kind: ex.kind, startMin: ex.startMin, endMin: ex.endMin, reason: ex.reason };
        })
      };
    }),
    dayNames: GH.DAY_NAMES
  };
}

/* Availability is always computed for the moment of the request, so it can never
   be stale. Both endpoints call this. */
function availability(query) {
  return GH.availableSlots(state, {
    salonId: query.salon, serviceId: query.service,
    staffId: query.staff && query.staff !== 'any' ? query.staff : null,
    dateISO: query.date, now: new Date()
  });
}

function diary(query) {
  return GH.diaryLanes(state, {
    salonId: query.salon, serviceId: query.service,
    staffId: query.staff && query.staff !== 'any' ? query.staff : null,
    dateISO: query.date, now: new Date()
  });
}

/* The soonest each stylist could take this service, for the per-stylist view. */
function staffAvailability(query) {
  var staff = GH.eligibleStaff(state, query.salon, query.service);
  return staff.map(function (s) {
    var got = GH.earliestSlot(state, {
      salonId: query.salon, serviceId: query.service, staffId: s.id, days: 14, now: new Date()
    });
    return {
      staffId: s.id, name: s.name,
      next: got ? { day: got.dateISO, startMin: got.startMin, startISO: got.startISO } : null
    };
  });
}

/* ---------- http ---------- */

var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, status, body, type) {
  var text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type || 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 100000) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      var raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { return resolve({}); }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  var rel = urlPath === '/' ? '/index.html' : urlPath;
  var cleaned = path.normalize(rel).replace(/^([/\\])+/, '');
  var full = path.join(ROOT, cleaned);
  /* never serve outside the demo folder */
  if (!full.startsWith(ROOT)) { return send(res, 403, { error: 'Nope' }); }
  /* The demo folder also holds the server itself and the database. Those are not
     web assets: serving goldenhue.db would hand over every customer record. */
  var name = path.basename(full).toLowerCase();
  var bannedExt = ['.db', '.db-wal', '.db-shm', '.log', '.env', '.sqlite', '.sqlite3'];
  if (name === 'server.js' || bannedExt.indexOf(path.extname(name)) >= 0 ||
      cleaned.split(/[/\\]/).some(function (seg) { return seg.charAt(0) === '.'; })) {
    return send(res, 403, { error: 'Not a web asset' });
  }
  fs.readFile(full, function (err, buf) {
    if (err) { return send(res, 404, { error: 'Not found' }); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
}

var server = http.createServer(async function (req, res) {
  var url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  var q = {};
  url.searchParams.forEach(function (v, k) { q[k] = v; });
  var route = url.pathname;

  try {
    if (route === '/api/bootstrap') { return send(res, 200, publicConfig()); }

    /* The raw catalogue, in exactly the shape engine.js already consumes, so the
       page builds its state from the same data the server uses. */
    if (route === '/api/catalog') {
      return send(res, 200, {
        salons: DATA.salons, services: DATA.services, staff: DATA.staff,
        salonsClosed: DATA.salonsClosed,
        /* bookings are not part of the catalogue: they come from the database via
           the range endpoint, so say so explicitly rather than leaving it out */
        appointments: [],
        serverNow: new Date().toISOString()
      });
    }

    /* Every live appointment in a window, for the page to mirror so it can keep
       computing availability locally between pushes. */
    if (route === '/api/appointments-range') {
      if (!q.salon || !q.from || !q.to) { return send(res, 400, { error: 'salon, from and to are required' }); }
      var range = db.prepare(`SELECT * FROM appointment
        WHERE salon_id = ? AND day >= ? AND day <= ? AND status IN ('pending','booked','confirmed')`).all(q.salon, q.from, q.to);
      return send(res, 200, { from: q.from, to: q.to, appointments: range.map(rowToAppointment), serverNow: new Date().toISOString() });
    }

    if (route === '/api/availability') {
      if (!q.salon || !q.service || !q.date) { return send(res, 400, { error: 'salon, service and date are required' }); }
      var av = availability(q);
      return send(res, 200, { date: q.date, staffId: q.staff || null, slots: av.slots, reason: av.reason, closedReason: av.closedReason, serverNow: new Date().toISOString() });
    }

    if (route === '/api/diary') {
      if (!q.salon || !q.service || !q.date) { return send(res, 400, { error: 'salon, service and date are required' }); }
      return send(res, 200, { date: q.date, lanes: diary(q), serverNow: new Date().toISOString() });
    }

    if (route === '/api/staff-availability') {
      if (!q.salon || !q.service) { return send(res, 400, { error: 'salon and service are required' }); }
      return send(res, 200, { staff: staffAvailability(q) });
    }

    if (route === '/api/book' && req.method === 'POST') {
      var body = await readBody(req);
      var out = createBooking(body);
      return send(res, out.status, out.body);
    }

    if (route === '/api/cancel' && req.method === 'POST') {
      var cbody = await readBody(req);
      var cout = cancelBooking(String(cbody.ref || ''));
      return send(res, cout.status, cout.body);
    }

    if (route === '/api/appointments') {
      if (!q.salon || !q.date) { return send(res, 400, { error: 'salon and date are required' }); }
      var rows = byDay.all(q.salon, q.date);
      return send(res, 200, { date: q.date, appointments: rows.map(rowToAppointment) });
    }

    if (route === '/api/stream') {
      if (!q.salon) { return send(res, 400, { error: 'salon is required' }); }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', at: new Date().toISOString() }) + '\n\n');
      if (!listeners.has(q.salon)) { listeners.set(q.salon, new Set()); }
      listeners.get(q.salon).add(res);
      /* a comment every 25s keeps a proxy from closing an idle stream */
      var beat = setInterval(function () {
        try { res.write(': ping\n\n'); } catch (e) { clearInterval(beat); }
      }, 25000);
      req.on('close', function () {
        clearInterval(beat);
        var set = listeners.get(q.salon);
        if (set) { set.delete(res); }
      });
      return;
    }

    if (route === '/health') {
      return send(res, 200, { ok: true, appointments: db.prepare('SELECT COUNT(*) AS n FROM appointment').get().n, now: new Date().toISOString() });
    }

    if (route.indexOf('/api/') === 0) { return send(res, 404, { error: 'Unknown endpoint' }); }
    return serveStatic(req, res, route);
  } catch (e) {
    console.error(route + ' failed: ' + e.message);
    return send(res, 500, { error: 'Server error', detail: e.message });
  }
});

seedIfEmpty();
loadAppointments();

server.listen(PORT, function () {
  console.log('Goldenhue booking server on http://localhost:' + PORT);
  console.log('database: ' + DB_FILE + '  (' + state.appointments.length + ' live appointments)');
});
