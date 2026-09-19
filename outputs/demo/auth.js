/* Who is allowed to change the salon's settings.

   Everything here is Node's own crypto: scrypt for passwords, HMAC for session
   cookies. No dependency, and nothing to configure except a password for the
   first account.

   The front desk is the only thing behind this. The booking page and its API stay
   open, because customers are not asked to have an account.

   ponytail: sessions are stateless signed cookies, so signing out clears the
   cookie but does not revoke a copy somebody already took. Fine for a salon with
   one or two logins; add a server-side session table the day there is a reason to
   kick someone out mid-session. */
'use strict';

var crypto = require('crypto');

var SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
var SESSION_DAYS = 30;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
}

function newSalt() { return crypto.randomBytes(16).toString('hex'); }

/* Constant-time compare, so a wrong password cannot be narrowed down by timing. */
function sameSecret(a, b) {
  var x = Buffer.from(String(a), 'utf8');
  var y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) { return false; }
  return crypto.timingSafeEqual(x, y);
}

function createAuth(store) {
  /* The secret is generated once and kept, so a restart does not sign everyone
     out and a second process shares the same secret. */
  var secret = null;

  /* Loaded once at boot rather than on every request: it is a round trip to the
     database now, and verify() has to stay synchronous because it runs on every
     single request. */
  async function init() {
    secret = await store.getSetting('session_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      await store.setSetting('session_secret', secret);
    }
  }

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  function issue(salonId) {
    var expires = Date.now() + SESSION_DAYS * 86400000;
    var payload = salonId + '.' + expires;
    return payload + '.' + sign(payload);
  }

  /* Returns the salon id when the cookie is genuine and unexpired, else null. */
  function verify(token) {
    if (!token) { return null; }
    var parts = String(token).split('.');
    if (parts.length !== 3) { return null; }
    var payload = parts[0] + '.' + parts[1];
    if (!sameSecret(parts[2], sign(payload))) { return null; }
    var expires = Number(parts[1]);
    if (!isFinite(expires) || expires < Date.now()) { return null; }
    return parts[0];
  }

  /* Create the first account for a salon. Returns false when one already exists,
     so this is safe to call on every boot. */
  async function ensureAdmin(salonId, email, password) {
    if (await store.countAdmins(salonId) > 0) { return false; }
    if (!email || !password || String(password).length < 8) { return false; }
    var salt = newSalt();
    await store.createAdmin({
      salonId: salonId, email: String(email).toLowerCase().trim(),
      passwordHash: hashPassword(password, salt), salt: salt
    });
    return true;
  }

  async function checkLogin(salonId, email, password) {
    var row = await store.findAdmin(salonId, String(email || '').toLowerCase().trim());
    if (!row) {
      /* Hash anyway, so a missing account and a wrong password take similar time. */
      hashPassword(String(password || ''), 'decoy-salt-value');
      return null;
    }
    return sameSecret(hashPassword(String(password || ''), row.salt), row.password_hash) ? row : null;
  }

  /* Keep the environment variable authoritative for that one account, so the
     password can be rotated by changing it and redeploying. Without this, a
     forgotten password would mean losing the database or editing it by hand,
     and neither is something to ask of a salon. */
  async function syncAdminPassword(salonId, email, password) {
    var row = await store.findAdmin(salonId, String(email).toLowerCase().trim());
    if (!row) { return await ensureAdmin(salonId, email, password); }
    if (sameSecret(hashPassword(String(password), row.salt), row.password_hash)) { return false; }
    var salt = newSalt();
    await store.updateAdminPassword(salonId, row.email, hashPassword(String(password), salt), salt);
    return true;
  }

  return {
    init: init, issue: issue, verify: verify, ensureAdmin: ensureAdmin,
    checkLogin: checkLogin, syncAdminPassword: syncAdminPassword
  };
}

/* Minimal cookie reading. The header is a semicolon-separated list of name=value
   pairs, and nothing here needs decoding beyond that. */
function readCookie(header, name) {
  if (!header) { return null; }
  var parts = String(header).split(';');
  for (var i = 0; i < parts.length; i += 1) {
    var eq = parts[i].indexOf('=');
    if (eq < 0) { continue; }
    if (parts[i].slice(0, eq).trim() === name) { return decodeURIComponent(parts[i].slice(eq + 1).trim()); }
  }
  return null;
}

function cookieHeader(name, value, maxAgeSeconds) {
  var bits = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  bits.push('Max-Age=' + maxAgeSeconds);
  /* Secure only over https, because Safari and Chrome drop a Secure cookie on
     http://localhost and the front desk would be impossible to use locally. */
  if (process.env.COOKIE_SECURE === '1') { bits.push('Secure'); }
  return bits.join('; ');
}

module.exports = {
  createAuth: createAuth, readCookie: readCookie, cookieHeader: cookieHeader,
  hashPassword: hashPassword, newSalt: newSalt
};
