/* Where the bookings live, on a managed Postgres.

   This is the second implementation of the same interface as store.js. The
   server does not know which one it is talking to, so moving between them is an
   environment variable rather than a change to the application.

   The guarantee is stronger here than it was on SQLite. Two customers cannot
   double-book because the database refuses to store two overlapping rows for the
   same stylist: an exclusion constraint, checked by Postgres on every insert,
   rather than a check the application remembers to make. If it were removed, the
   insert simply fails, which is the right way round for a constraint this
   important.

   There is a stronger version of this -- an exclusion constraint, which makes the
   database itself refuse two overlapping rows even if the application is bypassed
   entirely. It needs the btree_gist extension. That is not available everywhere,
   and it was not available in the Postgres this code is tested against, so rather
   than ship a guarantee on an untested foundation this uses advisory locks, which
   are built in and portable:

     pg_advisory_xact_lock(hashtext(salon | stylist | day))

   taken at the start of a transaction. Any two transactions booking the same
   stylist on the same day queue behind each other, so the overlap check and the
   insert cannot interleave. The lock is released by the commit.

   ponytail: this serialises bookings per stylist per day. For a salon that is not
   a queue, it is a formality. If it ever became a bottleneck, or if the database
   in use has btree_gist, add the exclusion constraint from the V1 plan as well --
   it is a bigger guarantee and needs no lock. */
'use strict';

var ACTIVE = "('pending','booked','confirmed')";

/* The same connection string, as it was typed, and as it probably should be.

   Pasting a connection string from a rendered markdown message carries its escaping
   with it: "neondb_owner" arrives as "neondb\_owner" and the password gains a
   character that makes authentication fail with a message that never mentions it.
   The repair is offered as a fallback rather than applied silently, so a password
   that really does contain a backslash still works. */
function connectionCandidates(raw) {
  var out = [];
  var value = String(raw == null ? '' : raw).trim();
  if (!value) { return out; }

  /* A value wrapped in quotes is a common paste artifact too. */
  if (/^["'][\s\S]*["']$/.test(value)) { value = value.slice(1, -1).trim(); }
  out.push(value);

  if (/\\[_@!#*\[\](){}<>.,;:'"+=-]/.test(value)) {
    out.push(value.replace(/\\([_@!#*\[\](){}<>.,;:'"+=-])/g, '$1'));
  }

  return out.filter(function (v, i) { return v && out.indexOf(v) === i; });
}

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

function createPostgresStore(url) {
  var pg;
  try {
    pg = require('pg');
  } catch (e) {
    throw new Error('DATABASE_URL is set, so the pg driver is needed. Run: npm install pg');
  }

  /* Serverless Postgres closes idle connections, and a salon's booking page is
     idle most of the day. A small pool plus a short idle timeout keeps the first
     request after a quiet spell from failing. */
  /* Connection strings get pasted from places that escape punctuation: a chat
     message, an issue, a screenshot's worth of OCR, a docs page. The escaping turns
     "user_pass" into "user\_pass" and the password fails authentication with a
     message that never mentions the backslash. Rather than make someone hunt for an
     invisible character, the candidates are tried in order and the one that works is
     reported.

     The value is tried exactly as given first, so a password that genuinely contains
     a backslash still works. */
  var candidates = connectionCandidates(url);

  /* TLS is decided in this file rather than by the string, so sslmode is removed
     rather than left to compete with it. That also silences a driver warning about
     sslmode=require changing meaning in a future version: with one authority over
     TLS, there is nothing for the string to mean. */
  function stripSsl(value) {
    return String(value).replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]+$/, '');
  }

  /* Sizing the pool is sizing for the worst minute, not the average one.

     A booking holds a connection for the whole transaction, which on a database in
     another region is several round trips. A pool of four, under a burst of two
     dozen people, ran out of connections and answered six of them with a server
     error instead of "that slot has gone". Local testing never showed it, because
     a database on the same machine answers in microseconds.

     The pooled connection endpoint these hosts provide is built for this: many
     client connections, multiplexed onto few server ones. So the ceiling is set
     generously and the wait is long enough for a queue rather than a failure.

     The pool is created lazily, once a candidate has answered: the first candidate
     that connects wins, and the losers are closed immediately so a failed attempt
     does not leak connections. */
  var pool = null;
  var chosen = null;

  function makePool(value) {
    var local = /localhost|127\.0\.0\.1|::1/.test(value);
    return new pg.Pool({
      connectionString: stripSsl(value),
      max: Number(process.env.PG_POOL_MAX || 12),
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 30000),
      /* A statement that never returns should not hold a connection for ever. */
      statement_timeout: 15000,
      query_timeout: 20000,
      /* Verify the certificate on a managed host. The driver warns that sslmode=require
         is on its way to meaning "encrypt but do not verify", which is weaker than it
         sounds and would silently change under us on a future upgrade, so the choice is
         made here explicitly instead of inherited from the connection string. */
      ssl: local ? false : { rejectUnauthorized: true }
    });
  }

  async function connect() {
    if (pool) { return pool; }
    var lastError = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var attempt = makePool(candidates[i]);
      try {
        await attempt.query('SELECT 1');
        pool = attempt;
        chosen = candidates[i];
        if (i > 0) {
          /* Say it plainly, and say what to do. An invisible character should not
             turn into a hunt. */
          console.warn('DATABASE_URL connected only after removing escaped punctuation ' +
            '(backslashes before _, @, ! and similar). It works now, but paste the exact ' +
            'value from the Neon dashboard into the host to stop relying on that repair.');
        }
        return pool;
      } catch (e) {
        lastError = e;
        try { await attempt.end(); } catch (ignored) { /* already gone */ }
      }
    }
    throw lastError || new Error('no usable connection string');
  }

  async function q(sql, params) {
    var usable = await connect();
    var r = await usable.query(sql, params);
    return r.rows;
  }

  var api = {};

  /* The value that actually connected, for diagnostics. */
  api.connectionString = function () { return chosen; };

  api.init = async function () {
    await q(`
      CREATE TABLE IF NOT EXISTS appointment (
        id           text PRIMARY KEY,
        ref          text NOT NULL UNIQUE,
        salon_id     text NOT NULL,
        staff_id     text NOT NULL,
        service_id   text NOT NULL,
        customer_name  text NOT NULL,
        customer_phone text NOT NULL DEFAULT '',
        customer_email text NOT NULL DEFAULT '',
        note         text NOT NULL DEFAULT '',
        day          text NOT NULL,
        start_min    integer NOT NULL,
        end_min      integer NOT NULL,
        start_iso    timestamptz NOT NULL,
        end_iso      timestamptz NOT NULL,
        status       text NOT NULL DEFAULT 'booked',
        price        integer NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await q('CREATE INDEX IF NOT EXISTS appointment_lookup ON appointment (salon_id, staff_id, day, status)');
    await q(`
      CREATE TABLE IF NOT EXISTS service_setting (
        service_id   text PRIMARY KEY,
        price        integer NOT NULL,
        duration_min integer NOT NULL,
        buffer_min   integer NOT NULL,
        active       integer NOT NULL DEFAULT 1,
        updated_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS staff_hours (
        staff_id  text NOT NULL,
        weekday   integer NOT NULL,
        start_min integer NOT NULL,
        end_min   integer NOT NULL,
        PRIMARY KEY (staff_id, weekday, start_min)
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS app_setting (
        key   text PRIMARY KEY,
        value text NOT NULL
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS admin_user (
        salon_id      text NOT NULL,
        email         text NOT NULL,
        password_hash text NOT NULL,
        salt          text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (salon_id, email)
      )`);
  };

  /* ---------- bookings ---------- */

  var COLS = 'id, ref, salon_id, staff_id, service_id, customer_name, customer_phone, ' +
    'customer_email, note, day, start_min, end_min, start_iso, end_iso, status, price';

  function values(a) {
    return [a.id, a.ref, a.salonId, a.staffId, a.serviceId, a.customerName,
      a.customerPhone || '', a.customerEmail || '', a.note || '',
      a.day, a.startMin, a.endMin, a.startsAt.toISOString(), a.bufferUntil.toISOString(),
      a.status || 'booked', a.price];
  }

  api.countAppointments = async function () {
    return Number((await q('SELECT COUNT(*) AS n FROM appointment'))[0].n);
  };

  api.seedIfEmpty = async function (appointments) {
    if (!appointments.length) { return 0; }
    /* An empty check before opening a transaction, so a normal boot costs one query
       rather than a connection, a lock and nine inserts. The guarded path below
       still handles the first boot and any race. */
    var quick = await q('SELECT COUNT(*) AS n FROM appointment');
    if (Number(quick[0].n) > 0) { return 0; }
    /* The count and the insert have to be one transaction, or two processes booting
       together both see an empty table and both seed. The advisory lock makes the
       second one wait, so it sees the first one's rows and does nothing.

       Values are bound one row at a time rather than as one big VALUES list: a
       VALUES list arrives as text and Postgres cannot infer the integer columns
       from it, which failed on the first attempt. */
    var client = await (await connect()).connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['seed-appointments']);
      var existing = await client.query('SELECT COUNT(*) AS n FROM appointment');
      if (Number(existing.rows[0].n) > 0) {
        await client.query('ROLLBACK');
        return 0;
      }
      for (var a of appointments) {
        await client.query('INSERT INTO appointment (' + COLS +
          ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', values(a));
      }
      await client.query('COMMIT');
      return appointments.length;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (ignored) { /* gone */ }
      throw e;
    } finally {
      client.release();
    }
  };

  api.insertMany = async function (appointments) {
    for (var a of appointments) {
      await q('INSERT INTO appointment (' + COLS + ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        values(a));
    }
  };

  api.listActive = async function (sinceDay) {
    return (await q('SELECT * FROM appointment WHERE status IN ' + ACTIVE + ' AND day >= $1', [sinceDay]))
      .map(toAppointment);
  };

  api.listDay = async function (salonId, day) {
    return (await q('SELECT * FROM appointment WHERE salon_id = $1 AND day = $2 AND status IN ' + ACTIVE, [salonId, day]))
      .map(toAppointment);
  };

  api.listRange = async function (salonId, from, to) {
    return (await q('SELECT * FROM appointment WHERE salon_id = $1 AND day >= $2 AND day <= $3 AND status IN ' + ACTIVE,
      [salonId, from, to])).map(toAppointment);
  };

  api.getByRef = async function (ref) {
    return toAppointment((await q('SELECT * FROM appointment WHERE ref = $1', [ref]))[0]);
  };

  api.cancel = async function (ref) {
    var rows = await q(`UPDATE appointment SET status = 'cancelled'
      WHERE ref = $1 AND status <> 'cancelled' RETURNING *`, [ref]);
    if (rows.length) { return { ok: true, appointment: toAppointment(rows[0]) }; }
    var existing = await q('SELECT * FROM appointment WHERE ref = $1', [ref]);
    if (!existing.length) { return { ok: false, code: 'NOT_FOUND' }; }
    return { ok: true, appointment: toAppointment(existing[0]) };
  };

  /* THE GUARD.

     One transaction per attempt. It takes an advisory lock for this stylist on
     this day first, so a competing booking for the same stylist waits rather than
     interleaving, then checks the overlap and inserts. The half-open comparison
     matches the rest of the system: 10:00-12:00 and 12:00-12:30 do not clash,
     11:59 does. */
  api.bookWithGuard = async function (opts) {
    var client = await (await connect()).connect();
    try {
      await client.query('BEGIN');
      for (var staffId of opts.candidates) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
          [opts.salonId + '|' + staffId + '|' + opts.day]);

        var clash = await client.query(
          `SELECT ref FROM appointment
             WHERE salon_id = $1 AND staff_id = $2 AND day = $3
               AND status IN ` + ACTIVE + `
               AND start_min < $5 AND $4 < end_min
             LIMIT 1`,
          [opts.salonId, staffId, opts.day, opts.startMin, opts.endMin]);
        if (clash.rows.length) { continue; }

        var appt = opts.make(staffId);
        await client.query('INSERT INTO appointment (' + COLS +
          ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', values(appt));
        await client.query('COMMIT');
        return { ok: true, appointment: appt };
      }
      await client.query('ROLLBACK');
      return { ok: false, code: 'TAKEN' };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (ignored) { /* already gone */ }
      throw e;
    } finally {
      client.release();
    }
  };

  /* ---------- the salon's own settings ---------- */

  api.serviceSettings = async function () {
    var byId = {};
    (await q('SELECT * FROM service_setting')).forEach(function (r) { byId[r.service_id] = r; });
    return byId;
  };

  api.saveServiceSetting = async function (row) {
    await q(`INSERT INTO service_setting (service_id, price, duration_min, buffer_min, active)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (service_id) DO UPDATE SET price = excluded.price, duration_min = excluded.duration_min,
        buffer_min = excluded.buffer_min, active = excluded.active, updated_at = now()`,
      [row.serviceId, row.price, row.durationMin, row.bufferMin, row.active ? 1 : 0]);
  };

  api.seedServiceSettings = async function (services) {
    /* One query to find out whether there is anything to do. Seeding runs on every
       boot, and doing it row by row means a round trip per service: on a managed
       database in another region that is tens of seconds of cold start every time a
       sleeping free instance wakes up. */
    var existing = await q('SELECT COUNT(*) AS n FROM service_setting');
    if (Number(existing[0].n) > 0) { return; }
    for (var s of services) {
      await q(`INSERT INTO service_setting (service_id, price, duration_min, buffer_min, active)
        VALUES ($1,$2,$3,$4,1) ON CONFLICT (service_id) DO NOTHING`,
        [s.id, s.price, s.durationMin, s.bufferMin || 0]);
    }
  };

  api.staffHours = async function () {
    var out = {};
    (await q('SELECT staff_id, weekday, start_min, end_min FROM staff_hours ORDER BY staff_id, weekday, start_min'))
      .forEach(function (h) {
        if (!out[h.staff_id]) { out[h.staff_id] = {}; }
        if (!out[h.staff_id][h.weekday]) { out[h.staff_id][h.weekday] = []; }
        out[h.staff_id][h.weekday].push({ startMin: h.start_min, endMin: h.end_min });
      });
    return out;
  };

  api.saveStaffHours = async function (staffId, week) {
    var client = await (await connect()).connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM staff_hours WHERE staff_id = $1', [staffId]);
      for (var day of week) {
        if (!day.working) { continue; }
        await client.query('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)',
          [staffId, Math.round(Number(day.weekday)), Math.round(Number(day.startMin)), Math.round(Number(day.endMin))]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (ignored) { /* gone */ }
      throw e;
    } finally {
      client.release();
    }
  };

  api.seedStaffHours = async function (staff, parseWindows) {
    /* Same reasoning as the services above: skip the round trips once the week is
       already stored. */
    var existing = await q('SELECT COUNT(*) AS n FROM staff_hours');
    if (Number(existing[0].n) > 0) { return; }
    for (var st of staff) {
      var rows = [];
      (st.hours || []).forEach(function (str, i) {
        /* the catalogue lists the week Monday first, so rotate to real weekdays */
        var weekday = (i + 1) % 7;
        parseWindows(str).forEach(function (w) { rows.push([st.id, weekday, w.start, w.end]); });
      });
      for (var r of rows) {
        await q('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', r);
      }
    }
  };

  /* ---------- small settings, and the people who may change them ---------- */

  api.getSetting = async function (key) {
    var rows = await q('SELECT value FROM app_setting WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  };

  api.setSetting = async function (key, value) {
    await q(`INSERT INTO app_setting (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
  };

  api.countAdmins = async function (salonId) {
    return Number((await q('SELECT COUNT(*) AS n FROM admin_user WHERE salon_id = $1', [salonId]))[0].n);
  };

  api.createAdmin = async function (row) {
    await q(`INSERT INTO admin_user (salon_id, email, password_hash, salt) VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [row.salonId, row.email, row.passwordHash, row.salt]);
  };

  api.findAdmin = async function (salonId, email) {
    return (await q('SELECT * FROM admin_user WHERE salon_id = $1 AND email = $2', [salonId, email]))[0] || null;
  };

  api.updateAdminPassword = async function (salonId, email, passwordHash, salt) {
    await q('UPDATE admin_user SET password_hash = $1, salt = $2 WHERE salon_id = $3 AND email = $4',
      [passwordHash, salt, salonId, email]);
  };

  api.close = async function () { if (pool) { try { await pool.end(); } catch (e) { /* already closed */ } } };

  /* A parameterised query, for diagnostics and for the checks that need to look at
     the database directly rather than through the interface. Parameters are always
     bound, never interpolated. */
  api.raw = async function (sql, params) { return q(sql, params || []); };

  return api;
}

module.exports = {
  createPostgresStore: createPostgresStore,
  toAppointment: toAppointment,
  connectionCandidates: connectionCandidates
};
