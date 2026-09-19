/* Does the app actually work against the real Neon instance?

   The Postgres store was tested against a local Postgres. Neon differs in ways that
   matter: it sits behind a connection pooler, it requires TLS, and it advertises
   channel binding. This checks the connection, the schema, and a real booking
   round trip before anyone depends on it.

   The connection string is read from the environment and never written to a file.
   Usage: NEEDS_DB_URL=1 node work/neon-check.js */
'use strict';
var path = require('path');

var url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('set NEON_DATABASE_URL first'); process.exit(2); }

var { createPostgresStore } = require(path.join(__dirname, '..', 'outputs/demo/store-postgres.js'));
var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

/** Never print the password, even by accident. */
function safe(u) { return String(u).replace(/\/\/[^:]+:[^@]+@/, '//***:***@'); }

(async function () {
  console.log('connecting to ' + safe(url));
  var store = createPostgresStore(url);

  /* 1. the connection itself */
  try {
    await store.init();
    check('connected and created the schema', true);
  } catch (e) {
    check('connected and created the schema', false, e.message);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(1);
  }

  /* 2. a version, to prove it is really Postgres and which one */
  try {
    var info = await store.raw('SELECT version() AS v, current_database() AS db');
    check('it is Postgres', /PostgreSQL/.test(info[0].v), String(info[0].v).slice(0, 60));
    console.log('     ' + String(info[0].v).split(',')[0]);
    console.log('     database: ' + info[0].db);
  } catch (e) {
    check('it is Postgres', false, e.message);
  }

  /* 3. does the pooler tolerate the driver's SQL? A pooler in transaction mode can
         break anything that assumes a session. */
  try {
    var t = await store.raw('SELECT 1 AS one');
    check('a simple query survives the pooler', t[0].one === 1);
  } catch (e) {
    check('a simple query survives the pooler', false, e.message);
  }

  /* 4. the guard, on this database, with two connections at once */
  var salonId = 'neon-test-salon', staffId = 'neon-test-staff', day = '2030-01-15';
  try {
    await store.raw('DELETE FROM appointment WHERE salon_id = $1', [salonId]);
    var made = await Promise.all([0, 1, 2, 3, 4, 5].map(function (i) {
      return store.bookWithGuard({
        salonId: salonId, day: day, startMin: 600, endMin: 700,
        candidates: [staffId],
        make: function (sid) {
          return {
            id: 'neon-' + i, ref: 'NEON' + i, salonId: salonId, staffId: sid, serviceId: 'x',
            customerName: 'Racer ' + i, day: day, startMin: 600, endMin: 700,
            startsAt: new Date('2030-01-15T10:00:00Z'), bufferUntil: new Date('2030-01-15T11:40:00Z'),
            status: 'booked', price: 1000
          };
        }
      });
    }));
    var won = made.filter(function (m) { return m.ok; }).length;
    check('six simultaneous bookings on real Neon produce exactly one winner', won === 1, won + ' won');
    var rows = await store.raw('SELECT COUNT(*) AS n FROM appointment WHERE salon_id = $1', [salonId]);
    check('the database holds one row', Number(rows[0].n) === 1, rows[0].n + ' rows');
  } catch (e) {
    check('six simultaneous bookings on real Neon produce exactly one winner', false, e.message);
  }

  /* 5. a cancelled booking must stop blocking its time */
  try {
    await store.raw(`UPDATE appointment SET status = 'cancelled' WHERE salon_id = $1`, [salonId]);
    var second = await store.bookWithGuard({
      salonId: salonId, day: day, startMin: 600, endMin: 700, candidates: [staffId],
      make: function (sid) {
        return {
          id: 'neon-after', ref: 'NEONAFTER', salonId: salonId, staffId: sid, serviceId: 'x',
          customerName: 'After Cancel', day: day, startMin: 600, endMin: 700,
          startsAt: new Date('2030-01-15T10:00:00Z'), bufferUntil: new Date('2030-01-15T11:40:00Z'),
          status: 'booked', price: 1000
        };
      }
    });
    check('a cancelled booking stops blocking its time', second.ok === true, JSON.stringify(second));
  } catch (e) {
    check('a cancelled booking stops blocking its time', false, e.message);
  }

  /* 6. clean up after ourselves: this is a real database someone will use */
  try {
    await store.raw('DELETE FROM appointment WHERE salon_id = $1', [salonId]);
    var left = await store.raw('SELECT COUNT(*) AS n FROM appointment WHERE salon_id = $1', [salonId]);
    check('the test data was removed', Number(left[0].n) === 0);
  } catch (e) {
    check('the test data was removed', false, e.message);
  }

  await store.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
