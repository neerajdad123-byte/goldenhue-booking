/* Where the bookings live.

   Everything that touches storage goes through this one module, so moving to
   Firestore is writing a second implementation of this file rather than hunting
   SQL through the server. There are no interfaces, no factories and no plugins:
   one object, one shape, two implementations eventually.

   The method that carries the whole product is bookWithGuard(). The overlap check
   and the insert happen inside it, atomically, which is the only way two people
   clicking the same slot at the same moment cannot both succeed. Availability can
   be computed anywhere; this cannot. */
'use strict';

var path = require('path');
var { DatabaseSync } = require('node:sqlite');
var GH = require('./engine.js');

var ACTIVE = "('pending','booked','confirmed')";

/* A real pause, because the driver is synchronous and there is no await to yield on. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* A stored row, in the shape the rest of the code speaks. */
function toAppointment(r) {
  if (!r) { return null; }
  return {
    id: r.id, ref: r.ref, salonId: r.salon_id, staffId: r.staff_id, serviceId: r.service_id,
    customerName: r.customer_name, customerPhone: r.customer_phone, customerEmail: r.customer_email,
    note: r.note, day: r.day, status: r.status, price: r.price,
    startsAt: new Date(r.start_iso), endsAt: new Date(r.end_iso),
    bufferUntil: new Date(r.end_iso), startMin: r.start_min, endMin: r.end_min
  };
}

function createStore(file) {
  var db = new DatabaseSync(file);
  /* Wait for a lock rather than failing the moment the database is busy. Without
     this a second process starting at the same time (a rolling deploy, a second
     instance) dies on boot with "database is locked", and a booking that lands
     while another write is in flight can fail for no good reason. */
  db.exec('PRAGMA busy_timeout = 5000');
  /* Switching the journal mode takes an exclusive lock of its own and does not
     wait, so two processes booting together can collide here. The mode is a
     property of the file, so one winner is enough: retry briefly, then move on. */
  for (var attempt = 0; attempt < 10; attempt += 1) {
    try { db.exec('PRAGMA journal_mode = WAL'); break; }
    catch (e) { sleep(25); }
  }

  var q = {};

  q.init = function () {
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
      CREATE TABLE IF NOT EXISTS service_setting (
        service_id   TEXT PRIMARY KEY,
        price        INTEGER NOT NULL,
        duration_min INTEGER NOT NULL,
        buffer_min   INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        updated_at   TEXT NOT NULL
      );
      /* Weekday is the real one, 0 Sunday through 6 Saturday, matching
         Date.getDay. More than one row per weekday allows a split shift. */
      CREATE TABLE IF NOT EXISTS staff_hours (
        staff_id  TEXT NOT NULL,
        weekday   INTEGER NOT NULL,
        start_min INTEGER NOT NULL,
        end_min   INTEGER NOT NULL,
        PRIMARY KEY (staff_id, weekday, start_min)
      );
      /* Small key/value corner: the session secret lives here so that restarting
         the server does not sign everyone out. */
      CREATE TABLE IF NOT EXISTS app_setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_user (
        salon_id      TEXT NOT NULL,
        email         TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt          TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (salon_id, email)
      );
    `);
  };

  /* ---------- small settings, and the people who may change them ---------- */

  q.getSetting = function (key) {
    var row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key);
    return row ? row.value : null;
  };

  q.setSetting = function (key, value) {
    db.prepare('INSERT INTO app_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  };

  q.countAdmins = function (salonId) {
    return db.prepare('SELECT COUNT(*) AS n FROM admin_user WHERE salon_id = ?').get(salonId).n;
  };

  q.createAdmin = function (row) {
    db.prepare('INSERT OR IGNORE INTO admin_user (salon_id, email, password_hash, salt, created_at) VALUES (?,?,?,?,?)')
      .run(row.salonId, row.email, row.passwordHash, row.salt, new Date().toISOString());
  };

  q.findAdmin = function (salonId, email) {
    return db.prepare('SELECT * FROM admin_user WHERE salon_id = ? AND email = ?').get(salonId, email) || null;
  };

  /* ---------- bookings ---------- */

  q.countAppointments = function () {
    return db.prepare('SELECT COUNT(*) AS n FROM appointment').get().n;
  };

  var insertSql = `INSERT INTO appointment
    (id, ref, salon_id, staff_id, service_id, customer_name, customer_phone, customer_email,
     note, day, start_min, end_min, start_iso, end_iso, status, price, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  function bind(a) {
    return [a.id, a.ref, a.salonId, a.staffId, a.serviceId, a.customerName,
      a.customerPhone || '', a.customerEmail || '', a.note || '',
      a.day, a.startMin, a.endMin, a.startsAt.toISOString(), a.bufferUntil.toISOString(),
      a.status || 'booked', a.price, new Date().toISOString()];
  }

  q.insertMany = function (appointments) {
    var ins = db.prepare(insertSql);
    db.exec('BEGIN IMMEDIATE');
    try {
      appointments.forEach(function (a) { ins.run.apply(ins, bind(a)); });
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (ignored) { /* already gone */ }
      throw e;
    }
  };

  /* Seeding has to be atomic with the check that the database is empty. Doing the
     count first and the insert afterwards looks fine until two processes start at
     the same moment, which is exactly what a rolling deploy does: both see an empty
     table, both try to seed, and the loser dies on boot with a duplicate key. */
  q.seedIfEmpty = function (appointments) {
    var ins = db.prepare(insertSql);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT COUNT(*) AS n FROM appointment').get().n > 0) {
        db.exec('ROLLBACK');
        return 0;
      }
      appointments.forEach(function (a) { ins.run.apply(ins, bind(a)); });
      db.exec('COMMIT');
      return appointments.length;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (ignored) { /* already gone */ }
      throw e;
    }
  };

  q.listActive = function (sinceDay) {
    return db.prepare('SELECT * FROM appointment WHERE status IN ' + ACTIVE + ' AND day >= ?')
      .all(sinceDay).map(toAppointment);
  };

  q.listDay = function (salonId, day) {
    return db.prepare('SELECT * FROM appointment WHERE salon_id = ? AND day = ? AND status IN ' + ACTIVE)
      .all(salonId, day).map(toAppointment);
  };

  q.listRange = function (salonId, from, to) {
    return db.prepare('SELECT * FROM appointment WHERE salon_id = ? AND day >= ? AND day <= ? AND status IN ' + ACTIVE)
      .all(salonId, from, to).map(toAppointment);
  };

  q.getByRef = function (ref) {
    return toAppointment(db.prepare('SELECT * FROM appointment WHERE ref = ?').get(ref));
  };

  q.cancel = function (ref) {
    var row = db.prepare('SELECT * FROM appointment WHERE ref = ?').get(ref);
    if (!row) { return { ok: false, code: 'NOT_FOUND' }; }
    if (row.status !== 'cancelled') {
      db.prepare('UPDATE appointment SET status = ? WHERE ref = ?').run('cancelled', ref);
    }
    return { ok: true, appointment: toAppointment(row) };
  };

  /* THE GUARD.

     Check and insert inside one immediate transaction, so nothing can slip
     between them: two servers, two requests, two customers, one winner.
     Half-open ranges, so 10:00-12:00 and 12:00-12:30 do not clash and 11:59 does.

     ponytail: BEGIN IMMEDIATE takes a write lock on the whole database, which is
     the right trade for a salon's booking rate and the wrong one at thousands of
     writes a second. The Firestore implementation below has no such ceiling. */
  q.bookWithGuard = function (opts) {
    var clash = db.prepare(`SELECT ref FROM appointment
      WHERE salon_id = ? AND staff_id = ? AND day = ?
        AND status IN ` + ACTIVE + `
        AND start_min < ? AND ? < end_min
      LIMIT 1`);
    var ins = db.prepare(insertSql);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (var i = 0; i < opts.candidates.length; i += 1) {
        var staffId = opts.candidates[i];
        if (clash.get(opts.salonId, staffId, opts.day, opts.endMin, opts.startMin)) { continue; }
        var appt = opts.make(staffId);
        ins.run.apply(ins, bind(appt));
        db.exec('COMMIT');
        return { ok: true, appointment: appt };
      }
      db.exec('ROLLBACK');
      return { ok: false, code: 'TAKEN' };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (ignored) { /* already gone */ }
      throw e;
    }
  };

  /* ---------- the salon's own settings ---------- */

  q.serviceSettings = function () {
    var byId = {};
    db.prepare('SELECT * FROM service_setting').all().forEach(function (r) { byId[r.service_id] = r; });
    return byId;
  };

  q.saveServiceSetting = function (row) {
    db.prepare(`INSERT INTO service_setting (service_id, price, duration_min, buffer_min, active, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(service_id) DO UPDATE SET price=excluded.price, duration_min=excluded.duration_min,
        buffer_min=excluded.buffer_min, active=excluded.active, updated_at=excluded.updated_at`)
      .run(row.serviceId, row.price, row.durationMin, row.bufferMin, row.active ? 1 : 0, new Date().toISOString());
  };

  q.seedServiceSettings = function (services) {
    /* Same trap as the appointment seed: the emptiness check has to live inside the
       transaction, or two processes starting together both decide the table is
       empty and the loser dies on a duplicate key. */
    var put = db.prepare('INSERT OR IGNORE INTO service_setting (service_id, price, duration_min, buffer_min, active, updated_at) VALUES (?,?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT COUNT(*) AS n FROM service_setting').get().n > 0) {
        db.exec('ROLLBACK');
        return;
      }
      services.forEach(function (s) { put.run(s.id, s.price, s.durationMin, s.bufferMin || 0, 1, new Date().toISOString()); });
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (ignored) {} throw e; }
  };

  /* Every stylist's week, as { staffId: { weekday: [{startMin, endMin}] } } with
     the real weekday numbers. */
  q.staffHours = function () {
    var out = {};
    db.prepare('SELECT staff_id, weekday, start_min, end_min FROM staff_hours ORDER BY staff_id, weekday, start_min')
      .all().forEach(function (h) {
        if (!out[h.staff_id]) { out[h.staff_id] = {}; }
        if (!out[h.staff_id][h.weekday]) { out[h.staff_id][h.weekday] = []; }
        out[h.staff_id][h.weekday].push({ startMin: h.start_min, endMin: h.end_min });
      });
    return out;
  };

  q.saveStaffHours = function (staffId, week) {
    var clear = db.prepare('DELETE FROM staff_hours WHERE staff_id = ?');
    var add = db.prepare('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      clear.run(staffId);
      week.forEach(function (day) {
        if (!day.working) { return; }
        add.run(staffId, Math.round(Number(day.weekday)), Math.round(Number(day.startMin)), Math.round(Number(day.endMin)));
      });
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (ignored) {} throw e; }
  };

  q.seedStaffHours = function (staff, parseWindows, asHm) {
    var add = db.prepare('INSERT OR IGNORE INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT COUNT(*) AS n FROM staff_hours').get().n > 0) {
        db.exec('ROLLBACK');
        return;
      }
      staff.forEach(function (st) {
        /* the catalogue lists the week Monday first, so rotate to real weekdays */
        (st.hours || []).forEach(function (str, i) {
          var weekday = (i + 1) % 7;
          parseWindows(str).forEach(function (w) { add.run(st.id, weekday, w.start, w.end); });
        });
      });
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (ignored) {} throw e; }
  };

  q.close = function () { try { db.close(); } catch (e) { /* already closed */ } };

  /* ---------------------------------------------------------------------------
     Notes for the Firestore implementation, so the guarantee is not lost in a
     rewrite. Nothing here is a suggestion to build now; the SQLite version above
     is what runs.

     Firestore has no exclusion constraints, so the guard becomes a lock document
     with a computed id, one per stylist per slot start:

         locks/{salonId}_{staffId}_{day}_{startMin}

     bookWithGuard() then runs one transaction: for each candidate, read that lock
     document, and if it is absent, write the lock and the appointment together,
     then commit. Firestore transactions are serialised on the documents they
     touch, so two requests racing for the same lock cannot both commit: one wins
     and the other is retried, finds the lock, moves to the next candidate, and
     returns TAKEN if there is none left. The appointment document is written
     inside the same transaction as its lock, so a lock can never exist without a
     booking behind it.

     Two things to carry over rather than rediscover: the lock is keyed on the
     slot start, not on the booking, so a cancelled booking must delete its lock
     in the same transaction as the status change; and the half-open comparison
     (start < otherEnd && otherStart < end) has to be done in code against an
     indexed query on (staffId, day), because Firestore cannot express a range
     overlap itself.
     --------------------------------------------------------------------------- */

  return q;
}

module.exports = { createStore: createStore, toAppointment: toAppointment };
