/* The real test: does an escaped connection string actually work against Neon?

   The value the deploy was given had backslashes in it. This connects to the real
   database using that exact mangled value, which is the only way to know the repair
   works rather than merely looks right.

   Usage: NEEDS_DB_URL=1 node work/neon-escaped-test.js */
'use strict';
var path = require('path');
var { createPostgresStore } = require(path.join(__dirname, '..', 'outputs/demo/store-postgres.js'));

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

var clean = process.env.NEON_DATABASE_URL;
if (!clean) { console.error('set NEON_DATABASE_URL first'); process.exit(2); }

/* Mangle it exactly as a pasted markdown message does: every underscore escaped. */
var BS = String.fromCharCode(92);
var escaped = clean.split('_').join(BS + '_');

(async function () {
  console.log('clean:   ' + clean.replace(/\/\/[^:]+:[^@]+@/, '//***@').slice(0, 72));
  console.log('escaped: ' + escaped.replace(/\/\/[^:]+:[^@]+@/, '//***@').slice(0, 72));
  check('the escaped value really is different', escaped !== clean);
  check('and it contains backslashes', escaped.indexOf(BS) >= 0);

  var store = createPostgresStore(escaped);
  try {
    await store.init();
    check('the app connected using the escaped value', true);
    var who = await store.raw('SELECT current_user AS u');
    check('as the right role', who[0].u === 'neondb_owner', who[0].u);
    check('and it reported which value worked', String(store.connectionString()).indexOf(BS) < 0,
      'it used the repaired value');
  } catch (e) {
    check('the app connected using the escaped value', false, e.message);
  }
  await store.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
