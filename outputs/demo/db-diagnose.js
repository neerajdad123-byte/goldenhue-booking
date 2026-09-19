/* Why did the database refuse us?

   "password authentication failed" is the least useful error in this whole system:
   it does not say which part is wrong, and the usual causes are invisible — a
   backslash that came along with a copied message, a quote, a trailing space, a
   password that was rotated after it was pasted, or a string from a different
   project.

   This describes the connection string without revealing it: the password is
   reported by length and character classes only, never by value. A wrong length is
   usually enough to spot a paste that lost or gained a character.

   Usage: node outputs/demo/db-diagnose.js "$DATABASE_URL" */
'use strict';

function describe(url) {
  var raw = String(url == null ? '' : url);
  var notes = [];
  var trimmed = raw.trim();

  if (!trimmed) { return { ok: false, notes: ['DATABASE_URL is empty or unset'] }; }

  /* The paste accidents, in the order they happen. */
  if (raw !== trimmed) { notes.push('the value has leading or trailing whitespace (a trailing newline is the usual one)'); }
  if (/^["']|["']$/.test(trimmed)) { notes.push('the value is wrapped in quotes, which are not part of a connection string'); }
  if (raw.indexOf('\\') >= 0) {
    notes.push('the value contains a backslash. Backslashes are not valid in a connection string, ' +
      'and they usually mean it was copied from a message that escaped punctuation. Remove them.');
  }
  if (/\s/.test(trimmed)) { notes.push('the value contains a space'); }

  var parsed = null;
  try { parsed = new URL(trimmed); } catch (e) {
    notes.push('the value is not a valid URL: ' + e.message);
    return { ok: false, notes: notes };
  }

  var password = decodeURIComponent(parsed.password || '');
  var user = decodeURIComponent(parsed.username || '');

  if (!user) { notes.push('there is no user in the string'); }
  if (!password) { notes.push('there is no password in the string'); }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    notes.push('the scheme is "' + parsed.protocol + '", expected postgresql:');
  }
  if (parsed.hostname.indexOf('neon.tech') >= 0 && !/sslmode=/.test(trimmed)) {
    notes.push('a Neon host with no sslmode; add ?sslmode=require');
  }
  if (!/pooler/.test(parsed.hostname)) {
    notes.push('this is not the pooled host (it does not contain "pooler"). That works, ' +
      'but the pooled string handles more connections at once.');
  }

  var classes = [];
  if (/[a-z]/.test(password)) { classes.push('lowercase'); }
  if (/[A-Z]/.test(password)) { classes.push('uppercase'); }
  if (/[0-9]/.test(password)) { classes.push('digits'); }
  if (/[^A-Za-z0-9]/.test(password)) { classes.push('symbols'); }

  return {
    ok: notes.length === 0,
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, '') || '(none)',
    user: user,
    passwordLength: password.length,
    passwordClasses: classes.join(', ') || '(none)',
    notes: notes
  };
}

/* A short report for a startup log. Never includes the password itself. */
function report(url) {
  var d = describe(url);
  var lines = [];
  lines.push('  host:     ' + (d.host || '(unreadable)'));
  lines.push('  database: ' + (d.database || '(unreadable)'));
  lines.push('  user:     ' + (d.user || '(unreadable)'));
  lines.push('  password: ' + (d.passwordLength == null ? '(unreadable)' :
    d.passwordLength + ' characters, ' + d.passwordClasses));
  if (d.notes && d.notes.length) {
    lines.push('  problems found in the value itself:');
    d.notes.forEach(function (n) { lines.push('    - ' + n); });
  } else {
    lines.push('  the value is well formed, so the problem is the password or the account:');
    lines.push('    - the password may have been rotated in Neon since it was pasted here');
    lines.push('    - or the string may be from a different Neon project');
    lines.push('    - copy it fresh from the Neon dashboard rather than from any message');
  }
  return lines.join('\n');
}

module.exports = { describe: describe, report: report };

if (require.main === module) {
  var arg = process.argv[2] || process.env.DATABASE_URL;
  if (!arg) { console.error('usage: node db-diagnose.js "$DATABASE_URL"'); process.exit(2); }
  console.log(report(arg));
  process.exit(describe(arg).ok ? 0 : 1);
}
