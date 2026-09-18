/* Tests against the running booking server over real HTTP.
   Usage: node work/api-test.js [base]   (default http://localhost:3000) */
var BASE = process.argv[2] || 'http://localhost:3000';
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

async function get(p, params) {
  var u = new URL(BASE + p);
  Object.keys(params || {}).forEach(function (k) { if (params[k] != null) { u.searchParams.set(k, params[k]); } });
  var r = await fetch(u);
  return { status: r.status, body: await r.json() };
}

async function post(p, body) {
  var r = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

(async function () {
  console.log('the server is up');
  var health = await get('/health');
  check('health answers', health.status === 200 && health.body.ok === true);

  var boot = await get('/api/bootstrap');
  check('bootstrap returns three salons', boot.body.salons.length === 3, boot.body.salons.length + ' salons');
  check('bootstrap returns services and staff', boot.body.services.length > 10 && boot.body.staff.length > 8);
  check('staff carry their working week', boot.body.staff[0].hours.length === 7);
  check('every service has a photo', boot.body.services.every(function (s) { return !!s.photo; }));

  /* Repeated runs fill the diary, so look for a day that still has room rather
     than assuming tomorrow is free. */
  var upcoming = null;
  for (var d = 1; d <= 21 && !upcoming; d += 1) {
    var probeDay = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    var probe = await get('/api/availability', { salon: 'goldenhue', service: 'gh-colour', staff: 'ramesh', date: probeDay });
    if (probe.body.slots && probe.body.slots.length >= 3) { upcoming = probeDay; }
  }
  check('a day with room was found to test against', !!upcoming, 'the next three weeks are full');

  console.log('availability is computed on the server, per stylist');
  var any = await get('/api/availability', { salon: 'goldenhue', service: 'gh-colour', staff: 'any', date: upcoming });
  check('any-stylist availability comes back', any.status === 200 && any.body.slots.length > 0, any.body.slots.length + ' slots');
  check('slots name the stylists who can take them', any.body.slots.every(function (s) { return s.staffIds.length > 0; }));
  check('every slot carries an ISO start', any.body.slots.every(function (s) { return !!s.startISO; }));

  var ramesh = await get('/api/availability', { salon: 'goldenhue', service: 'gh-colour', staff: 'ramesh', date: upcoming });
  check('one stylist gives a narrower set than the whole team', ramesh.body.slots.length <= any.body.slots.length);
  check('that stylist is the only one offered', ramesh.body.slots.every(function (s) {
    return s.staffIds.length === 1 && s.staffIds[0] === 'ramesh';
  }));

  var priya = await get('/api/availability', { salon: 'goldenhue', service: 'gh-colour', staff: 'priya', date: upcoming });
  check('a stylist who cannot do the service is refused', priya.body.slots.length === 0, String(priya.body.reason));

  var diary = await get('/api/diary', { salon: 'goldenhue', service: 'gh-colour', staff: 'any', date: upcoming });
  check('the diary returns one lane per capable stylist', diary.body.lanes.length === 2, diary.body.lanes.length + ' lanes');
  check('each lane knows its own busy and free time', diary.body.lanes.every(function (l) {
    return Array.isArray(l.busy) && Array.isArray(l.free) && Array.isArray(l.windows);
  }));
  check('lanes never overlap their own free time', diary.body.lanes.every(function (l) {
    return l.free.every(function (f) {
      return l.busy.every(function (b) { return !(f.start < b.end && b.start < f.end); });
    });
  }));

  var perStaff = await get('/api/staff-availability', { salon: 'goldenhue', service: 'gh-haircut' });
  check('per-stylist soonest is listed for everyone capable', perStaff.body.staff.length >= 3, perStaff.body.staff.length + ' stylists');
  check('and each names a next slot or none', perStaff.body.staff.every(function (s) {
    return s.next === null || (!!s.next.startISO && !!s.next.day);
  }));

  console.log('booking');
  var avail = await get('/api/availability', { salon: 'goldenhue', service: 'gh-haircut', staff: 'ramesh', date: upcoming });
  var slot = avail.body.slots[0];
  check('there is a slot to book', !!slot, 'none free tomorrow');

  var made = await post('/api/book', {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', startISO: slot.startISO,
    customer: { name: 'API Test', phone: '9000000001' }
  });
  check('a free slot books', made.status === 201, made.status + ' ' + JSON.stringify(made.body).slice(0, 90));
  check('it comes back with a reference', /^GH-[A-Z0-9]{6}$/.test(made.body.ref || ''), String(made.body.ref));
  check('it names the stylist', !!made.body.staffName);

  var again = await post('/api/book', {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', startISO: slot.startISO,
    customer: { name: 'API Test 2', phone: '9000000002' }
  });
  check('the same slot is refused the second time', again.status === 409, String(again.status));
  check('with the message the customer sees',
    again.body.message === 'Sorry, this slot has just been booked. Please select another time.', String(again.body.message));

  var afterBook = await get('/api/availability', { salon: 'goldenhue', service: 'gh-haircut', staff: 'ramesh', date: upcoming });
  check('the booked slot is gone from availability',
    !afterBook.body.slots.some(function (s) { return s.startISO === slot.startISO; }));

  console.log('the race the whole product exists to prevent');
  var fresh = await get('/api/availability', { salon: 'goldenhue', service: 'gh-beard', staff: 'ramesh', date: upcoming });
  var contested = fresh.body.slots[fresh.body.slots.length - 1];
  check('there is a slot to fight over', !!contested, 'no free slot found');
  var N = 24;
  var results = await Promise.all(Array.from({ length: N }, function (_, i) {
    return post('/api/book', {
      salonId: 'goldenhue', serviceId: 'gh-beard', staffId: 'ramesh', startISO: contested.startISO,
      customer: { name: 'Racer ' + i, phone: '90000001' + String(i).padStart(2, '0') }
    });
  }));
  var created = results.filter(function (r) { return r.status === 201; });
  var refused = results.filter(function (r) { return r.status === 409; });
  check(N + ' simultaneous bookings produce exactly one appointment', created.length === 1,
    created.length + ' created, ' + refused.length + ' refused, other: ' + (N - created.length - refused.length));
  check('everyone else gets the slot-taken message', refused.length === N - 1, refused.length + ' refusals');

  var stored = await get('/api/appointments', { salon: 'goldenhue', date: upcoming });
  var atContested = stored.body.appointments.filter(function (a) {
    return a.staffId === 'ramesh' && a.startMin === contested.startMin && a.status !== 'cancelled';
  });
  check('the database holds exactly one row for that time', atContested.length === 1, atContested.length + ' rows');

  console.log('cancelling');
  var cancel = await post('/api/cancel', { ref: made.body.ref });
  check('a booking can be cancelled', cancel.status === 200);
  var afterCancel = await get('/api/availability', { salon: 'goldenhue', service: 'gh-haircut', staff: 'ramesh', date: upcoming });
  check('and the time comes back', afterCancel.body.slots.some(function (s) { return s.startISO === slot.startISO; }));
  var cancelTwice = await post('/api/cancel', { ref: made.body.ref });
  check('cancelling twice is harmless', cancelTwice.status === 200);
  var cancelMissing = await post('/api/cancel', { ref: 'GH-NOPE00' });
  check('cancelling nothing is a 404', cancelMissing.status === 404, String(cancelMissing.status));

  console.log('live updates');
  var updates = [];
  var controller = new AbortController();
  fetch(BASE + '/api/stream?salon=cuttingroom', { signal: controller.signal }).then(function (r) {
    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    (function pump() {
      reader.read().then(function (chunk) {
        if (chunk.done) { return; }
        decoder.decode(chunk.value).split('\n\n').forEach(function (block) {
          var line = block.split('\n').filter(function (l) { return l.indexOf('data: ') === 0; })[0];
          if (line) { try { updates.push(JSON.parse(line.slice(6))); } catch (e) { /* partial */ } }
        });
        pump();
      }).catch(function () { /* aborted */ });
    }());
  }).catch(function () { /* aborted */ });

  await new Promise(function (r) { setTimeout(r, 700); });
  check('the stream greets a new listener', updates.some(function (u) { return u.type === 'hello'; }), JSON.stringify(updates));

  /* Repeated runs fill the diary, so hunt for any bookable slot rather than
     assuming a particular stylist on a particular day is free. */
  async function anyFreeSlot(salonId, serviceIds, staffIds) {
    for (var d = 1; d <= 14; d += 1) {
      var day = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
      for (var s of serviceIds) {
        for (var who of staffIds) {
          var r = await get('/api/availability', { salon: salonId, service: s, staff: who, date: day });
          if (r.body.slots && r.body.slots.length) {
            return { salonId: salonId, serviceId: s, staffId: who, date: day, slot: r.body.slots[0] };
          }
        }
      }
    }
    return null;
  }
  var spot = await anyFreeSlot('cuttingroom', ['cr-massage', 'cr-cut', 'cr-beard', 'cr-combo'], ['sameer', 'arjun', 'vikram']);
  if (spot) {
    var booked = await post('/api/book', {
      salonId: spot.salonId, serviceId: spot.serviceId, staffId: spot.staffId, startISO: spot.slot.startISO,
      customer: { name: 'Live Test', phone: '9000000003' }
    });
    check('a booking in another salon succeeds', booked.status === 201, String(booked.status));
    await new Promise(function (r) { setTimeout(r, 500); });
    check('it is pushed to open pages', updates.some(function (u) { return u.type === 'booked'; }), JSON.stringify(updates.slice(-2)));
    check('the push names the day and stylist', updates.some(function (u) {
      return u.type === 'booked' && u.day === spot.date && u.staffId === spot.staffId;
    }));
  } else {
    check('a booking is pushed to open pages', false, 'no free slot anywhere in the next fortnight');
  }
  check('a stream for one salon hears nothing from the others',
    updates.every(function (u) { return u.type === 'hello' || !spot || u.staffId === spot.staffId; }), JSON.stringify(updates));

  console.log('input the server must not trust');
  var badJson = await fetch(BASE + '/api/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  check('malformed json is rejected', badJson.status === 500 || badJson.status === 400, String(badJson.status));
  var noName = await post('/api/book', {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', startISO: contested.startISO, customer: { name: '  ' }
  });
  check('a blank name is rejected', noName.status === 400, String(noName.status));
  var badSalon = await post('/api/book', {
    salonId: 'nope', serviceId: 'gh-haircut', startISO: contested.startISO, customer: { name: 'X' }
  });
  check('an unknown salon is rejected', badSalon.status === 400, String(badSalon.status));
  var wrongStylist = await post('/api/book', {
    salonId: 'goldenhue', serviceId: 'gh-keratin', staffId: 'priya', startISO: contested.startISO,
    customer: { name: 'X' }
  });
  check('a stylist who cannot do the service cannot be booked for it', wrongStylist.status === 400, String(wrongStylist.status));
  var missing = await get('/api/availability', { salon: 'goldenhue' });
  check('a half-formed availability request is rejected', missing.status === 400, String(missing.status));
  /* the demo folder also holds the server and the database, and neither is a web asset */
  var serverSrc = await fetch(BASE + '/server.js');
  check('the server source is not downloadable', serverSrc.status === 403 || serverSrc.status === 404, String(serverSrc.status));
  var dbFile = await fetch(BASE + '/goldenhue.db');
  check('the database is not downloadable', dbFile.status === 403 || dbFile.status === 404, String(dbFile.status));
  var walFile = await fetch(BASE + '/goldenhue.db-wal');
  check('nor its write-ahead log', walFile.status === 403 || walFile.status === 404, String(walFile.status));
  var dotFile = await fetch(BASE + '/.env');
  check('nor dotfiles', dotFile.status === 403 || dotFile.status === 404, String(dotFile.status));
  var stillOk = await fetch(BASE + '/styles.css');
  check('but the real assets still load', stillOk.status === 200 && (stillOk.headers.get('content-type') || '').indexOf('css') >= 0, String(stillOk.status));

  controller.abort();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}()).catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
