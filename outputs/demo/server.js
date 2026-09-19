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
/* Two views of the same thing. `catalog` is the raw shape the page and the engine
   both understand, and it is what the admin edits. `state` is derived from it and
   is what availability is computed against. Change the catalog, rebuild the state,
   and everything downstream follows. */
var catalog = JSON.parse(JSON.stringify({
  salons: DATA.salons, services: DATA.services, staff: DATA.staff, salonsClosed: DATA.salonsClosed
}));
var state = GH.createState(catalog);

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

/* ---------- the salon's own settings, which the admin console edits ---------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS service_setting (
    service_id   TEXT PRIMARY KEY,
    price        INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    buffer_min   INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL
  );
  /* Weekday is the real one: 0 Sunday through 6 Saturday, matching Date.getDay.
     More than one row per weekday is allowed, for a split shift. */
  CREATE TABLE IF NOT EXISTS staff_hours (
    staff_id  TEXT NOT NULL,
    weekday   INTEGER NOT NULL,
    start_min INTEGER NOT NULL,
    end_min   INTEGER NOT NULL,
    PRIMARY KEY (staff_id, weekday, start_min)
  );
`);

function seedSettings() {
  if (db.prepare('SELECT COUNT(*) AS n FROM service_setting').get().n === 0) {
    var put = db.prepare('INSERT INTO service_setting (service_id, price, duration_min, buffer_min, active, updated_at) VALUES (?,?,?,?,?,?)');
    for (var s of catalog.services) {
      put.run(s.id, s.price, s.durationMin, s.bufferMin || 0, 1, new Date().toISOString());
    }
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM staff_hours').get().n === 0) {
    var putH = db.prepare('INSERT OR IGNORE INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
    for (var st of catalog.staff) {
      /* the raw catalogue lists the week Monday first, so rotate to real weekdays */
      (st.hours || []).forEach(function (str, i) {
        var weekday = (i + 1) % 7;
        GH.parseWindows(str).forEach(function (w) { putH.run(st.id, weekday, w.start, w.end); });
      });
    }
  }
}

function hm(mins) { return GH.hmOfMinutes(mins); }

/* Put the salon's saved settings back onto the raw catalogue. */
function applySettings() {
  var byId = {};
  db.prepare('SELECT * FROM service_setting').all().forEach(function (r) { byId[r.service_id] = r; });
  catalog.services.forEach(function (s) {
    var r = byId[s.id];
    if (!r) { return; }
    s.price = r.price;
    s.durationMin = r.duration_min;
    s.bufferMin = r.buffer_min;
    s.active = !!r.active;
  });

  var hours = {};
  db.prepare('SELECT * FROM staff_hours ORDER BY staff_id, weekday, start_min').all().forEach(function (h) {
    if (!hours[h.staff_id]) { hours[h.staff_id] = {}; }
    if (!hours[h.staff_id][h.weekday]) { hours[h.staff_id][h.weekday] = []; }
    hours[h.staff_id][h.weekday].push(hm(h.start_min) + '-' + hm(h.end_min));
  });
  catalog.staff.forEach(function (st) {
    var mine = hours[st.id];
    if (!mine) { return; }
    /* back to the Monday-first shape the engine and the page both expect */
    st.hours = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      var wd = (i + 1) % 7;
      return (mine[wd] && mine[wd].length) ? mine[wd].join(',') : 'OFF';
    });
  });
}

function rebuild() {
  applySettings();
  state = GH.createState(catalog);
  loadAppointments();
}

/* The guard. Half-open: 10:00-12:00 and 12:00-12:30 do not clash, 11:59 does. */
var clash = db.prepare(`SELECT ref FROM appointment
  WHERE salon_id = ? AND staff_id = ? AND day = ?
    AND status IN ('pending','booked','confirmed')
    AND start_min < ? AND ? < end_min
  LIMIT 1`);

/* ---------- mirror the database into the engine's shape ---------- */

function salonById(id) { return state.salons.filter(function (s) { return s.id === id; })[0]; }

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
  /* A day either side of today, because the salons in one deployment can sit in
     different timezones and this query has no single "today" to use. */
  var rows = db.prepare(`SELECT * FROM appointment
    WHERE status IN ('pending','booked','confirmed') AND day >= ?`).all(GH.addDays(GH.todayYmd(), -1));
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
    var host = GH.getSalon(state, a.salonId);
    var startMin = GH.wallMinutes(a.startsAt, host.tz);
    var endMin = GH.wallMinutes(a.bufferUntil, host.tz);
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
  /* The salon's clock, not the host's. A server running in UTC must still record
     10:00 as 10:00 where the chairs are, or every booking shifts by the offset. */
  var day = GH.wallDay(start, salon.tz);
  var startMin = GH.wallMinutes(start, salon.tz);
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
  if (day === GH.todayIn(salon.tz)) {
    var mins = GH.wallMinutes(now, salon.tz);
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
  /* the front desk lives at /admin, next to the customer page at / */
  var rel = urlPath === '/' ? '/index.html'
    : (urlPath === '/admin' || urlPath === '/admin/') ? '/admin.html'
    : urlPath;
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
        salons: catalog.salons, services: catalog.services, staff: catalog.staff,
        salonsClosed: catalog.salonsClosed,
        /* bookings are not part of the catalogue: they come from the database via
           the range endpoint, so say so explicitly rather than leaving it out */
        appointments: [],
        serverNow: new Date().toISOString()
      });
    }

    /* ---------- the admin console ---------- */

    if (route === '/api/admin/summary') {
      if (!q.salon || !q.date) { return send(res, 400, { error: 'salon and date are required' }); }
      var rows = byDay.all(q.salon, q.date);
      var dayStaff = GH.staffForSalon(state, q.salon);
      var lanes = dayStaff.map(function (st) {
        var windows = GH.staffWindows(st, salonById(q.salon), q.date);
        return {
          staffId: st.id, name: st.name, title: st.title,
          working: windows.length > 0,
          hours: windows.map(function (w) { return hm(w.start) + '-' + hm(w.end); }).join(', '),
          bookedMinutes: rows.filter(function (r) { return r.staff_id === st.id; })
            .reduce(function (n, r) { return n + (r.end_min - r.start_min); }, 0),
          appointments: rows.filter(function (r) { return r.staff_id === st.id; }).map(rowToAppointment)
        };
      });
      var revenue = rows.reduce(function (n, r) { return n + r.price; }, 0);
      return send(res, 200, {
        date: q.date, salonId: q.salon, lanes: lanes,
        totalAppointments: rows.length, revenue: revenue
      });
    }

    if (route === '/api/admin/config') {
      if (!q.salon) { return send(res, 400, { error: 'salon is required' }); }
      var svc = db.prepare('SELECT * FROM service_setting').all();
      var mine = {};
      svc.forEach(function (r) { mine[r.service_id] = r; });
      return send(res, 200, {
        salonId: q.salon,
        dayNames: GH.DAY_NAMES,
        services: catalog.services.filter(function (s) { return s.salonId === q.salon; }).map(function (s) {
          var r = mine[s.id] || {};
          return {
            id: s.id, name: s.name, category: s.category, photo: s.photo,
            price: r.price != null ? r.price : s.price,
            durationMin: r.duration_min != null ? r.duration_min : s.durationMin,
            bufferMin: r.buffer_min != null ? r.buffer_min : (s.bufferMin || 0),
            active: r.active != null ? !!r.active : true
          };
        }),
        staff: catalog.staff.filter(function (x) { return x.salonId === q.salon; }).map(function (st) {
          var week = {};
          db.prepare('SELECT weekday, start_min, end_min FROM staff_hours WHERE staff_id = ? ORDER BY weekday, start_min')
            .all(st.id).forEach(function (h) {
              if (!week[h.weekday]) { week[h.weekday] = { startMin: h.start_min, endMin: h.end_min, extra: [] }; }
              else { week[h.weekday].extra.push({ startMin: h.start_min, endMin: h.end_min }); }
            });
          return {
            id: st.id, name: st.name, title: st.title,
            services: st.services,
            week: [0, 1, 2, 3, 4, 5, 6].map(function (wd) {
              var w = week[wd];
              return { weekday: wd, working: !!w, startMin: w ? w.startMin : 540, endMin: w ? w.endMin : 1080 };
            })
          };
        })
      });
    }

    if (route === '/api/admin/service' && req.method === 'POST') {
      var sbody = await readBody(req);
      var svcRow = catalog.services.filter(function (s) { return s.id === sbody.serviceId; })[0];
      if (!svcRow) { return send(res, 404, { error: 'No such service' }); }
      var price = Math.round(Number(sbody.price));
      var duration = Math.round(Number(sbody.durationMin));
      var buffer = Math.round(Number(sbody.bufferMin));
      if (!isFinite(price) || price < 0 || price > 100000000) { return send(res, 400, { error: 'Price must be a whole number of paise, up to 10 lakh' }); }
      if (!isFinite(duration) || duration < 5 || duration > 600) { return send(res, 400, { error: 'Duration must be between 5 and 600 minutes' }); }
      if (!isFinite(buffer) || buffer < 0 || buffer > 120) { return send(res, 400, { error: 'Turnaround must be between 0 and 120 minutes' }); }
      db.prepare(`INSERT INTO service_setting (service_id, price, duration_min, buffer_min, active, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(service_id) DO UPDATE SET price=excluded.price, duration_min=excluded.duration_min,
          buffer_min=excluded.buffer_min, active=excluded.active, updated_at=excluded.updated_at`)
        .run(svcRow.id, price, duration, buffer, sbody.active === false ? 0 : 1, new Date().toISOString());
      rebuild();
      broadcast(svcRow.salonId, { type: 'settings', serviceId: svcRow.id });
      return send(res, 200, { ok: true, serviceId: svcRow.id, price: price, durationMin: duration, bufferMin: buffer });
    }

    if (route === '/api/admin/hours' && req.method === 'POST') {
      var hbody = await readBody(req);
      var who = catalog.staff.filter(function (s) { return s.id === hbody.staffId; })[0];
      if (!who) { return send(res, 404, { error: 'No such stylist' }); }
      if (!Array.isArray(hbody.week) || hbody.week.length !== 7) { return send(res, 400, { error: 'Send all seven days' }); }
      for (var day of hbody.week) {
        var wd = Math.round(Number(day.weekday));
        if (!(wd >= 0 && wd <= 6)) { return send(res, 400, { error: 'Bad weekday' }); }
        if (!day.working) { continue; }
        var a = Math.round(Number(day.startMin)), b = Math.round(Number(day.endMin));
        if (!isFinite(a) || !isFinite(b) || a < 0 || b > 1440 || b - a < 15) {
          return send(res, 400, { error: 'Each working day needs a start and an end at least 15 minutes apart' });
        }
      }
      var clear = db.prepare('DELETE FROM staff_hours WHERE staff_id = ?');
      var add = db.prepare('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        clear.run(who.id);
        hbody.week.forEach(function (day) {
          if (!day.working) { return; }
          add.run(who.id, Math.round(Number(day.weekday)), Math.round(Number(day.startMin)), Math.round(Number(day.endMin)));
        });
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
      rebuild();
      broadcast(who.salonId, { type: 'settings', staffId: who.id });
      return send(res, 200, { ok: true, staffId: who.id });
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
seedSettings();
rebuild();

server.listen(PORT, function () {
  console.log('Goldenhue booking server on http://localhost:' + PORT);
  console.log('database: ' + DB_FILE + '  (' + state.appointments.length + ' live appointments)');
});
