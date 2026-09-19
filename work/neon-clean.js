/* Remove anything the checks created in a real database, leaving only the seeded
   example bookings. Run this against a database someone will actually use.
   Usage: NEON_DATABASE_URL=... node work/neon-clean.js */
'use strict';
var path = require('path');
var url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('set NEON_DATABASE_URL first'); process.exit(2); }

var { createPostgresStore } = require(path.join(__dirname, '..', 'outputs/demo/store-postgres.js'));

/* Names the checks use. Anything else is left alone. */
var TEST_NAMES = ['API Test', 'API Test 2', 'Live Test', 'Second Tab', 'Cross Tab',
  'Persistence Test', 'Neon Check', 'Bypass Attempt', 'Cancelled Booking'];

(async function () {
  var store = createPostgresStore(url);
  await store.init();

  var before = await store.raw('SELECT COUNT(*) AS n FROM appointment');
  var removed = await store.raw(
    `DELETE FROM appointment
      WHERE customer_name = ANY($1) OR customer_name LIKE 'Racer %'
      RETURNING ref, customer_name`, [TEST_NAMES]);
  var after = await store.raw('SELECT COUNT(*) AS n FROM appointment');

  console.log('appointments before: ' + before[0].n);
  console.log('removed ' + removed.length + ' test bookings: ' +
    removed.map(function (r) { return r.customer_name; }).join(', ').slice(0, 200));
  console.log('appointments after: ' + after[0].n + ' (the seeded examples remain)');
  await store.close();
  process.exit(0);
})().catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
