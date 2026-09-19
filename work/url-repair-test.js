/* Connection strings arrive with the escaping of whatever they were pasted from.
   This checks that the app recovers, and that it does not damage a value that was
   already correct.

   Usage: node work/url-repair-test.js */
'use strict';
var path = require('path');
var { connectionCandidates } = require(path.join(__dirname, '..', 'outputs/demo/store-postgres.js'));

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function parse(v) { return new URL(v); }

/* A stand-in with the same shape as a real connection string. It must never be a
   real credential: this file is committed, and a committed password is a published
   password. Real ones belong in an environment variable and nowhere else. */
/* Both the user and the password contain an underscore, like the real ones, so the
   escapes land exactly where a pasted value would put them. */
var USER = 'db_user';
var PASSWORD = 's3cret_Pass-123';
var GOOD = 'postgresql://' + USER + ':' + PASSWORD +
  '@ep-example-1234-pooler.c-6.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require';

/* 1. A clean value is left alone. There must be exactly one candidate, or a working
      password could be silently replaced by a guess. */
var clean = connectionCandidates(GOOD);
check('a clean value yields exactly one candidate', clean.length === 1, clean.length + ' candidates');
check('and it is unchanged', clean[0] === GOOD);

/* 2. Escaped underscores, the markdown case. This is what arrived. */
/* Built from a character code on purpose. Written as a literal, a backslash before
   an underscore in JavaScript source is just an underscore: an unknown escape drops
   the backslash, so the test would quietly check a string with no backslash in it
   and pass while proving nothing. That mistake was made once already. */
var BS = String.fromCharCode(92);
var escaped = GOOD.split(USER).join('db' + BS + '_user');
var fix = connectionCandidates(escaped);
check('an escaped value yields a second candidate', fix.length === 2, fix.length + ' candidates');
check('the first candidate is what was given, untouched', fix[0] === escaped);
check('the second has the backslash removed', fix[1].indexOf(String.fromCharCode(92)) < 0, fix[1].slice(0, 40));
check('and the repaired value parses with the right user', parse(fix[1]).username === USER, parse(fix[1]).username);
check('with the right password', decodeURIComponent(parse(fix[1]).password) === PASSWORD,
  decodeURIComponent(parse(fix[1]).password));

/* 3. Escapes in the password as well as the user. */
var both = GOOD.split(USER).join('db' + BS + '_user').split('s3cret_').join('s3cret' + BS + '_');
var fixBoth = connectionCandidates(both);
check('escapes in both user and password are repaired', fixBoth.length === 2 && fixBoth[1].indexOf(String.fromCharCode(92)) < 0,
  JSON.stringify(fixBoth.map(function (v) { return v.slice(0, 30); })));
check('and the repaired password matches the original',
  decodeURIComponent(parse(fixBoth[1]).password) === PASSWORD,
  decodeURIComponent(parse(fixBoth[1]).password));

/* 4. Quotes and whitespace, the other paste artifacts. */
var quoted = '"' + GOOD + '"';
var fixQuoted = connectionCandidates(quoted);
check('a value wrapped in quotes is unwrapped', fixQuoted[0] === GOOD, fixQuoted[0].slice(0, 30));
var padded = '  ' + GOOD + '\n';
var fixPadded = connectionCandidates(padded);
check('trailing whitespace is trimmed', fixPadded[0] === GOOD, JSON.stringify(fixPadded[0].slice(-20)));

/* 5. A password that genuinely contains a backslash must still be tried as given. */
/* A password that genuinely contains two backslashes. */
var realBackslash = 'postgresql://user:pa' + BS + BS + 'ss@host.example.com/db';
var fixReal = connectionCandidates(realBackslash);
check('a real backslash in a password is tried first, as given', fixReal[0] === realBackslash, fixReal[0]);

/* 6. Nonsense in, no candidates out, rather than a wrong guess. */
check('an empty value yields nothing', connectionCandidates('').length === 0);
check('a whitespace-only value yields nothing', connectionCandidates('   ').length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
