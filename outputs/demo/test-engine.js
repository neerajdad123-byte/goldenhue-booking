/* Self-check for the availability engine.  node test-engine.js  */
var assert = require('assert');
var GH = require('./engine.js');
var DATA = require('./data.js');

var pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* A weekday the staff pattern definitely covers, far enough out that the seeded
   bookings (today and tomorrow) and the temp exceptions cannot interfere. */
function dayWithWeekday(target) {
  var d = GH.addDays(GH.todayYmd(), 8);
  for (var i = 0; i < 14; i += 1) {
    if (GH.weekdayOf(d) === target) { return d; }
    d = GH.addDays(d, 1);
  }
  throw new Error('no such weekday found');
}
var TUE = dayWithWeekday(2);
var state = GH.createState(DATA);

function slots(day, serviceId, staffId, now) {
  return GH.availableSlots(state, {
    salonId: 'goldenhue', serviceId: serviceId, staffId: staffId, dateISO: day, now: now
  });
}
function starts(res) { return res.slots.map(function (s) { return s.startMin; }); }
function at(day, h, m) { return GH.atMinutes(day, h * 60 + (m || 0)).toISOString(); }

console.log('range maths');
check('half-open: touching ranges do not overlap', function () {
  assert.strictEqual(GH.overlap(0, 120, 120, 150), false);
});
check('half-open: one minute of overlap counts', function () {
  assert.strictEqual(GH.overlap(0, 120, 119, 125), true);
});
check('subtract carves a lunch hour out of a shift', function () {
  var out = GH.subtract([{ start: 540, end: 1080 }], [{ start: 780, end: 840 }]);
  assert.deepStrictEqual(out, [{ start: 540, end: 780 }, { start: 840, end: 1080 }]);
});

console.log('working windows');
check('Ramesh on a Tuesday: two windows around lunch', function () {
  var w = GH.staffWindows(GH.getStaff(state, 'ramesh'), GH.getSalon(state, 'goldenhue'), TUE);
  assert.deepStrictEqual(w, [{ start: 540, end: 780 }, { start: 840, end: 1080 }]);
});
check('an OFF weekday yields no windows', function () {
  var wed = dayWithWeekday(3);
  var w = GH.staffWindows(GH.getStaff(state, 'ramesh'), GH.getSalon(state, 'goldenhue'), wed);
  assert.deepStrictEqual(w, []);
});
check('day_off exception beats a working weekday', function () {
  var tue2 = dayWithWeekday(2);
  var staff = GH.getStaff(state, 'ramesh');
  staff.exceptions.push({ date: tue2, kind: 'day_off', startMin: null, endMin: null, reason: 'test' });
  assert.deepStrictEqual(GH.staffWindows(staff, GH.getSalon(state, 'goldenhue'), tue2), []);
  staff.exceptions.pop();
});
check('custom_hours replaces the weekly pattern', function () {
  var tue3 = dayWithWeekday(2);
  var staff = GH.getStaff(state, 'ramesh');
  staff.exceptions.push({ date: tue3, kind: 'custom_hours', startMin: 600, endMin: 840, reason: 'half day' });
  /* 10:00-14:00 custom hours, still minus the 13:00 lunch */
  assert.deepStrictEqual(GH.staffWindows(staff, GH.getSalon(state, 'goldenhue'), tue3), [{ start: 600, end: 780 }]);
  staff.exceptions.pop();
});
check('salon holiday closes every stylist', function () {
  var closed = GH.addDays(GH.todayYmd(), 6);
  var res = slots(closed, 'gh-haircut', 'ramesh');
  assert.strictEqual(res.slots.length, 0);
  assert.strictEqual(res.closedReason, 'Staff training day');
});
check('salon closed on its weekly off day', function () {
  var sun = dayWithWeekday(0);
  var res = GH.availableSlots(state, { salonId: 'blushbloom', serviceId: 'bb-facial', staffId: 'meera', dateISO: sun });
  assert.strictEqual(res.slots.length, 0);
});

console.log('eligibility');
check('asking for a stylist who cannot do the service yields nothing', function () {
  var probe = GH.createState(DATA);
  var res = GH.availableSlots(probe, {
    salonId: 'goldenhue', serviceId: 'gh-colour', staffId: 'priya', dateISO: TUE
  });
  assert.strictEqual(res.slots.length, 0, 'offered slots for an incapable stylist');
  assert.strictEqual(res.reason, 'NO_STAFF');
});
check('and cannot be booked for it either', function () {
  var probe = GH.createState(DATA);
  var out = GH.book(probe, {
    salonId: 'goldenhue', serviceId: 'gh-keratin', staffId: 'priya',
    startISO: GH.atMinutes(TUE, 600).toISOString(),
    customer: { name: 'Sneaky', phone: '9000000123' }
  });
  assert.strictEqual(out.ok, false, 'booked an incapable stylist');
  assert.strictEqual(out.code, 'NO_STAFF');
});
check('keratin leaves only the stylist trained for it', function () {
  var ids = GH.eligibleStaff(state, 'goldenhue', 'gh-keratin').map(function (s) { return s.id; });
  assert.deepStrictEqual(ids, ['ramesh']);
});
check('any-stylist slots only offer capable stylists', function () {
  var res = slots(TUE, 'gh-spa', null);
  var all = {};
  res.slots.forEach(function (s) { s.staffIds.forEach(function (id) { all[id] = 1; }); });
  assert.deepStrictEqual(Object.keys(all).sort(), ['anjali', 'priya']);
});

console.log('booking');
check('a 2 hour colour blocks its own duration and its buffer', function () {
  var res = GH.book(state, {
    salonId: 'goldenhue', serviceId: 'gh-colour', staffId: 'ramesh', startISO: at(TUE, 10),
    customer: { name: 'Test A', phone: '9000000001' }
  });
  assert.strictEqual(res.ok, true);
  var open = starts(slots(TUE, 'gh-haircut', 'ramesh'));
  assert.ok(open.indexOf(690) === -1, '11:30 should be gone');
  assert.ok(open.indexOf(705) === -1, '11:45 should be gone');
  assert.ok(open.indexOf(720) === -1, '12:00 is inside the 15 min buffer');
  assert.ok(open.indexOf(840) >= 0, '2:00 PM after lunch should be free');
  assert.ok(open.indexOf(540) >= 0, '9:00 should still be free');
});
check('the same slot cannot be booked twice', function () {
  var res = GH.book(state, {
    salonId: 'goldenhue', serviceId: 'gh-colour', staffId: 'ramesh', startISO: at(TUE, 10),
    customer: { name: 'Test B', phone: '9000000002' }
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.message, GH.SLOT_TAKEN_MESSAGE);
});
check('any-stylist falls through to whoever is free', function () {
  var res = GH.book(state, {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: null, startISO: at(TUE, 10),
    customer: { name: 'Test C', phone: '9000000003' }
  });
  assert.strictEqual(res.ok, true);
  assert.notStrictEqual(res.staff.id, 'ramesh');
});
check('cancelling puts the slot back', function () {
  var open = starts(slots(TUE, 'gh-haircut', 'ramesh'));
  assert.ok(open.indexOf(720) === -1);
  var booked = state.appointments.filter(function (a) {
    return a.staffId === 'ramesh' && a.day === TUE && a.serviceId === 'gh-colour';
  })[0];
  GH.cancel(state, booked.ref);
  assert.ok(starts(slots(TUE, 'gh-haircut', 'ramesh')).indexOf(720) >= 0, '12:00 should be free again');
});
check('lead time hides slots that are too soon', function () {
  var res = slots(TUE, 'gh-haircut', 'ramesh', GH.atMinutes(TUE, 23 * 60));
  assert.strictEqual(res.slots.length, 0);
});
check('nothing is offered past the booking horizon', function () {
  var far = GH.addDays(GH.todayYmd(), 400);
  assert.strictEqual(slots(far, 'gh-haircut', 'ramesh').slots.length, 0);
});

console.log('display helpers');
check('a booking lands on the salon clock, not the host clock', function () {
  var probe = GH.createState(DATA);
  var salon = GH.getSalon(probe, 'goldenhue');
  /* 10:00 in Bengaluru is 04:30 UTC. The host's own timezone must not matter. */
  var instant = new Date(Date.UTC(2026, 8, 19, 4, 30));
  assert.strictEqual(GH.wallDay(instant, salon.tz), '2026-09-19');
  assert.strictEqual(GH.wallMinutes(instant, salon.tz), 600);
  /* and back again: 10:00 on the salon clock is that same instant */
  assert.strictEqual(GH.atMinutes('2026-09-19', 600, salon.tz).toISOString(), instant.toISOString());
});
check('without the offset the reading is wrong, which is why it is passed', function () {
  /* late evening UTC is already tomorrow morning in India */
  var instant = new Date(Date.UTC(2026, 8, 19, 20, 0));
  assert.strictEqual(GH.wallDay(instant, 330), '2026-09-20');
  assert.strictEqual(GH.wallDay(instant, 0), '2026-09-19');
  assert.strictEqual(GH.wallMinutes(instant, 330), 90);
  assert.strictEqual(GH.wallMinutes(instant, 0), 1200);
});
check('the salon day is read on the salon clock everywhere', function () {
  var probe = GH.createState(DATA);
  var salon = GH.getSalon(probe, 'goldenhue');
  assert.strictEqual(salon.tz, 330, 'salons default to India');
  /* a slot offered for a date must round-trip back to that date and minute */
  var res = GH.availableSlots(probe, {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', dateISO: TUE
  });
  assert.ok(res.slots.length > 0, 'nothing offered, so there is nothing to round-trip');
  res.slots.forEach(function (s) {
    var when = new Date(s.startISO);
    assert.strictEqual(GH.wallDay(when, salon.tz), TUE, 'slot ' + s.startISO + ' reads as another day');
    assert.strictEqual(GH.wallMinutes(when, salon.tz), s.startMin, 'slot ' + s.startISO + ' reads as another minute');
  });
});
check('salon copy survives normalisation', function () {
  /* a catalogue with no bookings must still build: the server sends them apart */
  var bare = GH.createState({ salons: DATA.salons, services: DATA.services, staff: DATA.staff });
  assert.strictEqual(bare.appointments.length, 0, 'a catalogue without bookings should start empty');
  assert.ok(bare.salons.length === 3, 'and still know its salons');
  var probe = GH.createState(DATA);
  probe.salons.forEach(function (s) {
    var raw = DATA.salons.filter(function (r) { return r.id === s.id; })[0];
    assert.ok(s.headline && s.headline.length > 10, s.id + ' lost its headline');
    assert.ok(s.sub && s.sub.length > 10, s.id + ' lost its sub');
    assert.strictEqual(s.reviews.length, raw.reviews.length, s.id + ' lost reviews');
    assert.strictEqual(s.brand.deep, raw.brand.deep, s.id + ' lost its text colour');
    assert.strictEqual(s.cover, raw.cover, s.id + ' lost its cover photo');
    assert.strictEqual(s.gallery.length, raw.gallery.length, s.id + ' lost its gallery');
  });
});
check('every photo the data names exists on disk', function () {
  var probe = GH.createState(DATA);
  var fs = require('fs'), path = require('path');
  probe.services.forEach(function (v) {
    assert.ok(v.photo, v.id + ' has no photo');
    assert.ok(fs.existsSync(path.join(__dirname, v.photo)), v.id + ' points at a missing file: ' + v.photo);
  });
  probe.salons.forEach(function (s) {
    assert.ok(fs.existsSync(path.join(__dirname, s.cover)), s.id + ' cover missing: ' + s.cover);
    s.gallery.forEach(function (g) {
      assert.ok(fs.existsSync(path.join(__dirname, g)), s.id + ' gallery missing: ' + g);
    });
  });
});
check('every review names the service it was for', function () {
  var probe = GH.createState(DATA);
  probe.salons.forEach(function (s) {
    var names = GH.servicesForSalon(probe, s.id).map(function (v) { return v.name; });
    s.reviews.forEach(function (r) {
      assert.ok(names.indexOf(r.service) >= 0, s.id + ' reviews a service it does not offer: ' + r.service);
    });
  });
});
check('earliest slot searches forward past a fully booked day', function () {
  var probe = GH.createState(DATA);
  var got = GH.earliestSlot(probe, { salonId: 'goldenhue', serviceId: 'gh-keratin', staffId: null, days: 14 });
  assert.ok(got, 'keratin should be bookable within a fortnight');
  assert.ok(got.dateISO >= GH.todayYmd(), 'never in the past');
  /* and the slot it names must really be offered by the day it names */
  var res = GH.availableSlots(probe, {
    salonId: 'goldenhue', serviceId: 'gh-keratin', staffId: null, dateISO: got.dateISO
  });
  assert.ok(res.slots.some(function (s) { return s.startMin === got.startMin; }), 'named slot is not on the rail');
});
check('earliest slot agrees with the rail after a booking', function () {
  var probe = GH.createState(DATA);
  var first = GH.earliestSlot(probe, { salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', days: 14 });
  GH.book(probe, {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', startISO: first.startISO,
    customer: { name: 'Block', phone: '9000000111' }
  });
  var next = GH.earliestSlot(probe, { salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', days: 14 });
  assert.notStrictEqual(next.startISO, first.startISO, 'the taken slot is still being offered');
  var res = GH.availableSlots(probe, {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', dateISO: next.dateISO
  });
  assert.ok(res.slots.some(function (s) { return s.startMin === next.startMin; }), 'next claim is not bookable');
});
check('returns nothing when a salon is shut for the whole search', function () {
  var probe = GH.createState(DATA);
  assert.strictEqual(GH.earliestSlot(probe, { salonId: 'goldenhue', serviceId: 'gh-keratin', staffId: null, days: 0 }), null);
});
check('every free block the diary shows can actually be booked', function () {
  var probe = GH.createState(DATA);
  var svc = GH.getService(probe, 'gh-haircut');
  var need = svc.durationMin + svc.bufferMin;
  var lanes = GH.diaryLanes(probe, { salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', dateISO: TUE });
  var lane = lanes[0];
  var blocks = lane.free.filter(function (f) { return f.end - f.start >= need; });
  assert.ok(blocks.length >= 2, 'expected a couple of usable blocks, got ' + blocks.length);
  blocks.forEach(function (f) {
    var out = GH.book(probe, {
      salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh',
      startISO: GH.atMinutes(TUE, f.start).toISOString(),
      customer: { name: 'Diary Check', phone: '9000000009' }
    });
    assert.strictEqual(out.ok, true, 'block at ' + f.start + ' refused: ' + (out.message || out.code));
  });
});
check('a diary block that has already passed is not offered', function () {
  var today = GH.todayYmd();
  var lanes = GH.diaryLanes(state, {
    salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', dateISO: today,
    now: GH.atMinutes(today, 16 * 60)
  });
  lanes[0].free.forEach(function (f) {
    assert.ok(f.end > 16 * 60 + 60, 'block ending ' + f.end + ' should have been clipped');
  });
});
check('busy time inside a lane matches the bookings on the books', function () {
  var lanes = GH.diaryLanes(state, { salonId: 'goldenhue', serviceId: 'gh-haircut', staffId: 'ramesh', dateISO: GH.todayYmd() });
  var lane = lanes[0];
  lane.busy.forEach(function (b) {
    assert.ok(b.end > b.start, 'busy block must be positive');
    lane.free.forEach(function (f) {
      assert.ok(!(f.start < b.end && b.start < f.end), 'free block overlaps a booking');
    });
  });
});
check('rupee grouping', function () {
  assert.strictEqual(GH.formatINR(80000), '\u20B9800');
  assert.strictEqual(GH.formatINR(250000), '\u20B92,500');
  assert.strictEqual(GH.formatINR(400000), '\u20B94,000');
  assert.strictEqual(GH.formatINR(1250000), '\u20B912,500');
});
check('duration wording', function () {
  assert.strictEqual(GH.durationLabel(45), '45 min');
  assert.strictEqual(GH.durationLabel(120), '2 hrs');
  assert.strictEqual(GH.durationLabel(75), '1 hr 15 min');
});
check('clock wording', function () {
  assert.strictEqual(GH.clockLabel(540), '9:00 AM');
  assert.strictEqual(GH.clockLabel(720), '12:00 PM');
  assert.strictEqual(GH.clockLabel(1020), '5:00 PM');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
