/* The store is async now, because a managed Postgres is reached over the network.
   In server.js and auth.js every store call needs awaiting, and the functions that
   call them need to be async.

   The rule is deliberately blunt: in these two files, every store method returns a
   promise, so every call site awaits. Anything that does not match is reported
   rather than silently skipped.

   Usage: node work/awaitify.js */
'use strict';
var fs = require('fs');
var path = require('path');

/* Each file gets its own list: server.js has the booking functions, auth.js has
   the ones that touch accounts. Guessing a shared list crashed this the first time. */
var FILES = [
  { name: 'server.js', funcs: [
    'loadAppointments', 'freshBookings', 'availability', 'diary', 'staffAvailability',
    'applySettings', 'rebuild', 'seedSettings', 'seedIfEmpty',
    'createBooking', 'cancelBooking', 'bootstrapAdmin'
  ] },
  { name: 'auth.js', funcs: ['init', 'ensureAdmin', 'checkLogin', 'syncAdminPassword'] }
].map(function (f) {
  f.path = path.join(__dirname, '..', 'outputs/demo', f.name);
  return f;
});

/* The methods that are genuinely sync and must not be awaited. */
var KEEP_SYNC = [/\.verify\(/];

var total = { awaited: 0, funced: 0 };

/* The local functions that became async also have to be awaited at their call
   sites. Missing these is invisible in a syntax check and shows up as an endpoint
   returning a shape with the fields silently dropped, which is how this was found
   the first time. */
var INTERNAL_ASYNC = [
  'loadAppointments', 'freshBookings', 'availability', 'diary', 'staffAvailability',
  'applySettings', 'rebuild', 'seedSettings', 'seedIfEmpty',
  'createBooking', 'cancelBooking', 'bootstrapAdmin'
];
var INTERNAL_RE = new RegExp(
  '(?<!await )(?<!function )(?<![.\\w])(' + INTERNAL_ASYNC.join('|') + ')\\(', 'g');

FILES.forEach(function (spec) {
  var file = spec.path;
  var src = fs.readFileSync(file, 'utf8');
  var before = src;

  /* await every store call, unless it is already awaited */
  src = src.replace(/(?<!await )\b(store)\.([a-zA-Z]+)\(/g, function (m, obj, method) {
    total.awaited += 1;
    return 'await ' + obj + '.' + method + '(';
  });

  /* the four auth calls that touch the store */
  src = src.replace(/(?<!await )\bauth\.(init|ensureAdmin|syncAdminPassword|checkLogin)\(/g, function (m, method) {
    total.awaited += 1;
    return 'await auth.' + method + '(';
  });

  /* the functions that now contain an await must be declared async */
  spec.funcs.forEach(function (name) {
    var needle = 'function ' + name + '(';
    if (src.indexOf('async ' + needle) >= 0) { return; }
    var hits = src.split(needle).length - 1;
    if (hits !== 1) { throw new Error(file + ': expected one "' + needle + '", found ' + hits); }
    src = src.replace(needle, 'async function ' + name + '(');
    total.funced += 1;
  });

  /* await calls to the local async functions, but never the declarations */
  src = src.replace(INTERNAL_RE, function (m, name) {
    total.awaited += 1;
    return 'await ' + name + '(';
  });

  /* Already applied is a fine outcome: the await rule is idempotent, so a second
     run over a converted file is a no-op rather than a failure. */
  if (src === before) { console.log(path.basename(file) + ': already converted'); }
  else { fs.writeFileSync(file, src); }

  /* report anything still calling the store without awaiting, so a miss is visible */
  var leftovers = (src.match(/(?<!await )\bstore\.[a-zA-Z]+/g) || []);
  console.log(path.basename(file) + ': awaited calls, leftover unawaited: ' + (leftovers.length ? leftovers.join(', ') : 'none'));
});

console.log('done: ' + total.awaited + ' calls awaited, ' + total.funced + ' functions made async');
