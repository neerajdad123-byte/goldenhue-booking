/* Availability engine + booking rules.
   Pure logic, no DOM: the browser and the Node self-check both load this file.
   This is the algorithm the Postgres function will implement in P0-proper;
   until then it is the single source of truth for what is bookable. */
var GH = (function () {
  'use strict';

  var MIN = 60000;
  var SLOT_TAKEN_MESSAGE = 'Sorry, this slot has just been booked. Please select another time.';
  var NO_STAFF_MESSAGE = 'That stylist does not do this service. Pick someone else.';
  var ACTIVE = { pending: 1, booked: 1, confirmed: 1 };
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------- time helpers ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0); }
  function todayYmd() { return ymd(new Date()); }
  function addDays(day, n) { var d = parseYmd(day); d.setDate(d.getDate() + n); return ymd(d); }
  function weekdayOf(day) { return parseYmd(day).getDay(); }
  function atMinutes(day, mins) { return new Date(parseYmd(day).getTime() + mins * MIN); }
  function minutesOfDay(hm) { var p = String(hm).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function hmOfMinutes(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function minutesOfDate(d) { return d.getHours() * 60 + d.getMinutes(); }

  function clockLabel(mins) {
    var h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12;
    if (h12 === 0) { h12 = 12; }
    return h12 + ':' + pad(m) + ' ' + ap;
  }

  function durationLabel(mins) {
    if (mins < 60) { return mins + ' min'; }
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + ' hr ' + m + ' min' : h + (h === 1 ? ' hr' : ' hrs');
  }

  function formatINR(paise) {
    var s = String(Math.round(paise / 100));
    if (s.length <= 3) { return '\u20B9' + s; }
    var last3 = s.slice(-3), rest = s.slice(0, -3);
    return '\u20B9' + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }

  function dateParts(day) {
    var d = parseYmd(day);
    return { dow: DOW[d.getDay()], day: String(d.getDate()), month: MON[d.getMonth()], isToday: day === todayYmd() };
  }

  /* Half-open overlap. 10:00-12:00 and 12:00-12:30 do NOT overlap; 11:59-12:05 does.
     The same rule as the '[)' range in the database exclusion constraint. */
  function overlap(aS, aE, bS, bE) { return aS < bE && bS < aE; }

  /* ---------- range maths on minutes-from-midnight ---------- */

  function parseWindows(str) {
    if (!str || str === 'OFF') { return []; }
    return String(str).split(',').map(function (part) {
      var se = part.split('-');
      return { start: minutesOfDay(se[0]), end: minutesOfDay(se[1]) };
    }).filter(function (w) { return w.end > w.start; });
  }

  /* Seed data lists the week Monday first because that is how a human reads it.
     JS getDay() puts Sunday at 0, so rotate: data[0] is Monday, data[6] is Sunday.
     Everything downstream indexes by the real weekday number. */
  function orderWeek(mondayFirst) {
    var out = new Array(7);
    mondayFirst.forEach(function (str, i) { out[(i + 1) % 7] = parseWindows(str); });
    return out;
  }

  function intersect(a, b) {
    var out = [];
    a.forEach(function (x) {
      b.forEach(function (y) {
        var s = Math.max(x.start, y.start), e = Math.min(x.end, y.end);
        if (e > s) { out.push({ start: s, end: e }); }
      });
    });
    return out;
  }

  function subtract(windows, cuts) {
    var out = windows.slice();
    cuts.forEach(function (cut) {
      var next = [];
      out.forEach(function (w) {
        if (!overlap(w.start, w.end, cut.start, cut.end)) { next.push(w); return; }
        if (cut.start > w.start) { next.push({ start: w.start, end: cut.start }); }
        if (cut.end < w.end) { next.push({ start: cut.end, end: w.end }); }
      });
      out = next;
    });
    return out.filter(function (w) { return w.end > w.start; });
  }

  /* ---------- seeding ---------- */

  function normaliseStaff(raw, salonId, today) {
    return {
      id: raw.id, salonId: salonId, name: raw.name, title: raw.title, bio: raw.bio,
      services: raw.services.slice(),
      hoursMin: orderWeek(raw.hours),
      /* Recurring breaks. They sit inside the working day, so subtracting a break
         that falls outside a window simply leaves the window alone. */
      breaksMin: (raw.breaks || []).map(function (b) {
        return { start: minutesOfDay(b[0]), end: minutesOfDay(b[1]), label: b[2] || 'Break' };
      }),
      exceptions: (raw.exceptions || []).map(function (ex) {
        return {
          date: ex.date || addDays(today, ex.dayOffset || 0),
          kind: ex.kind,
          startMin: ex.start ? minutesOfDay(ex.start) : null,
          endMin: ex.end ? minutesOfDay(ex.end) : null,
          reason: ex.reason || ''
        };
      })
    };
  }

  function createState(data) {
    var today = todayYmd();

    var salons = data.salons.map(function (s) {
      return {
        id: s.id, name: s.name, tagline: s.tagline, address: s.address, phone: s.phone,
        /* booking-page copy belongs to the salon, so it is carried through here
           rather than read from the raw data by the UI */
        headline: s.headline, sub: s.sub, reviews: (s.reviews || []).slice(),
        cover: s.cover || null, gallery: (s.gallery || []).slice(),
        currency: 'INR', timezone: 'Asia/Kolkata', brand: s.brand,
        slotStepMin: s.slotStepMin, leadTimeMin: s.leadTimeMin, horizonDays: s.horizonDays,
        cancellationHours: s.cancellationHours,
        hoursMin: orderWeek(s.hours),
        closed: {}
      };
    });

    function salon(id) { return salons.filter(function (s) { return s.id === id; })[0]; }

    (data.salonsClosed || []).forEach(function (c) {
      var s = salon(c.salonId);
      if (s) { s.closed[addDays(today, c.dayOffset)] = c.reason || 'Closed'; }
    });

    var services = data.services.map(function (v) {
      return { id: v.id, salonId: v.salonId, name: v.name, category: v.category, photo: v.photo || null,
               desc: v.desc, durationMin: v.durationMin, bufferMin: v.bufferMin || 0, price: v.price };
    });

    var staff = data.staff.map(function (st) { return normaliseStaff(st, st.salonId, today); });

    /* bookings are optional here: the server keeps them in the database and sends
       them separately, so a catalogue without them must still build */
    var appointments = (data.appointments || []).map(function (a, i) {
      var svc = services.filter(function (s) { return s.id === a.serviceId; })[0];
      var day = addDays(today, a.dayOffset || 0);
      var start = atMinutes(day, minutesOfDay(a.start));
      var end = new Date(start.getTime() + svc.durationMin * MIN);
      return {
        id: 'seed-' + i, ref: makeRef(), salonId: a.salonId, staffId: a.staffId, serviceId: a.serviceId,
        customerName: a.customerName, customerPhone: '', note: '',
        startsAt: start, endsAt: end,
        bufferUntil: new Date(end.getTime() + svc.bufferMin * MIN),
        status: 'booked', price: svc.price, day: day
      };
    });

    return { salons: salons, services: services, staff: staff, appointments: appointments };
  }

  function makeRef() {
    var chars = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
    for (var i = 0; i < 6; i += 1) { out += chars[Math.floor(Math.random() * chars.length)]; }
    return 'GH-' + out;
  }

  /* ---------- lookups ---------- */

  function getSalon(state, id) { return state.salons.filter(function (s) { return s.id === id; })[0]; }
  function getService(state, id) { return state.services.filter(function (s) { return s.id === id; })[0]; }
  function getStaff(state, id) { return state.staff.filter(function (s) { return s.id === id; })[0]; }

  function servicesForSalon(state, salonId) { return state.services.filter(function (s) { return s.salonId === salonId; }); }
  function staffForSalon(state, salonId) { return state.staff.filter(function (s) { return s.salonId === salonId; }); }

  function eligibleStaff(state, salonId, serviceId) {
    return state.staff.filter(function (st) {
      return st.salonId === salonId && st.services.indexOf(serviceId) >= 0;
    });
  }

  /* One stylist, but only if they actually do this service. Asking for someone who
     cannot do it must never yield a bookable slot, whoever is asking: the browser,
     the server, or somebody hand-writing an API call. */
  function capableStaff(state, salonId, serviceId, staffId) {
    var list = eligibleStaff(state, salonId, serviceId);
    if (!staffId) { return list; }
    return list.filter(function (s) { return s.id === staffId; });
  }

  /* ---------- availability ---------- */

  function staffWindows(staff, salon, day) {
    var wd = weekdayOf(day);
    if (salon.closed[day]) { return []; }

    var windows = staff.hoursMin[wd].slice();
    staff.exceptions.forEach(function (ex) {
      if (ex.date !== day) { return; }
      if (ex.kind === 'day_off') { windows = []; }
      if (ex.kind === 'custom_hours') { windows = [{ start: ex.startMin, end: ex.endMin }]; }
      if (ex.kind === 'extra_hours') { windows = windows.concat([{ start: ex.startMin, end: ex.endMin }]); }
    });
    if (!windows.length) { return []; }

    windows = subtract(windows, staff.breaksMin);

    return intersect(windows, salon.hoursMin[wd]).sort(function (a, b) { return a.start - b.start; });
  }

  function activeOn(state, staffId, day) {
    return state.appointments.filter(function (a) {
      return a.staffId === staffId && ACTIVE[a.status] && a.day === day;
    });
  }

  /* Slots are computed, never stored. Every request re-reads hours, exceptions and
     live bookings, so there is nothing to go stale. */
  function availableSlots(state, opts) {
    var salon = getSalon(state, opts.salonId);
    var svc = getService(state, opts.serviceId);
    var day = opts.dateISO;
    var now = opts.now || new Date();
    var step = salon.slotStepMin;
    var need = svc.durationMin + svc.bufferMin;
    var leadUntil = now.getTime() + salon.leadTimeMin * MIN;
    var lastDay = addDays(todayYmd(), salon.horizonDays);

    var result = { slots: [], reason: null, closedReason: salon.closed[day] || null };
    if (day > lastDay) { result.reason = 'TOO_FAR'; return result; }

    var candidates = capableStaff(state, opts.salonId, opts.serviceId, opts.staffId);
    if (!candidates.length) { result.reason = 'NO_STAFF'; return result; }

    var byStart = {}, order = [];
    candidates.forEach(function (st) {
      if (!st) { return; }
      var windows = staffWindows(st, salon, day);
      if (!windows.length) { return; }
      var busy = activeOn(state, st.id, day).map(function (a) {
        return { s: a.startsAt.getTime(), e: a.bufferUntil.getTime() };
      });

      windows.forEach(function (w) {
        for (var t = w.start; t + need <= w.end; t += step) {
          var start = atMinutes(day, t);
          var endMs = start.getTime() + need * MIN;
          if (start.getTime() < leadUntil) { continue; }
          var clash = busy.some(function (b) { return overlap(start.getTime(), endMs, b.s, b.e); });
          if (clash) { continue; }
          if (!byStart[t]) { byStart[t] = { startMin: t, startISO: start.toISOString(), staffIds: [] }; order.push(t); }
          byStart[t].staffIds.push(st.id);
        }
      });
    });

    order.sort(function (a, b) { return a - b; });
    order.forEach(function (t) { result.slots.push(byStart[t]); });
    if (!result.slots.length && !result.closedReason) { result.reason = 'FULLY_BOOKED'; }
    return result;
  }

  function nextDays(salon, count) {
    var out = [], start = todayYmd();
    for (var i = 0; i < count; i += 1) {
      var day = addDays(start, i);
      out.push({ date: day, closed: !!salon.closed[day], reason: salon.closed[day] || null, dow: weekdayOf(day) });
    }
    return out;
  }

  /* The earliest slot this service can actually be booked into, searching forward.
     Backs both the "next free" shortcut and the day the diary opens on, so the two
     can never disagree about what "soonest" means. */
  function earliestSlot(state, opts) {
    /* an explicit 0 must stay 0, so no || default here */
    var days = nextDays(getSalon(state, opts.salonId), opts.days == null ? 14 : opts.days);
    for (var i = 0; i < days.length; i += 1) {
      if (days[i].closed) { continue; }
      var res = availableSlots(state, {
        salonId: opts.salonId, serviceId: opts.serviceId, staffId: opts.staffId,
        dateISO: days[i].date, now: opts.now || new Date()
      });
      if (res.slots.length) {
        return {
          dateISO: days[i].date, slot: res.slots[0],
          startMin: res.slots[0].startMin, startISO: res.slots[0].startISO,
          staffIds: res.slots[0].staffIds, dayOffset: i
        };
      }
    }
    return null;
  }

  /* The data behind the diary view: one lane per stylist, each with the hours
     they work, the time already taken, and what is genuinely left. Free segments
     that have already passed (or sit inside the minimum lead time on today's
     date) are clipped away, so a block on screen is always a block you can take. */
  function diaryLanes(state, opts) {
    var salon = getSalon(state, opts.salonId);
    var now = opts.now || new Date();
    var step = salon.slotStepMin;
    var leadCut = opts.dateISO === todayYmd() ? minutesOfDate(now) + salon.leadTimeMin : -1;

    var people = opts.staffId ? [getStaff(state, opts.staffId)] : eligibleStaff(state, opts.salonId, opts.serviceId);
    return people.filter(Boolean).map(function (st) {
      var windows = staffWindows(st, salon, opts.dateISO);
      var busy = activeOn(state, st.id, opts.dateISO).map(function (a) {
        return { start: minutesOfDate(a.startsAt), end: minutesOfDate(a.bufferUntil) };
      });
      var free = subtract(windows, busy).map(function (f) {
        if (f.end <= leadCut) { return null; }
        if (f.start < leadCut) {
          var snapped = Math.ceil(leadCut / step) * step;
          return snapped < f.end ? { start: snapped, end: f.end } : null;
        }
        return f;
      }).filter(Boolean);
      return { staff: st, windows: windows, busy: busy, free: free };
    });
  }

  /* ---------- booking ---------- */

  /* NOTE: check-then-insert is only safe here because the demo runs on one thread.
     In the real build the Postgres exclusion constraint refuses the second writer
     even across processes; this function becomes a thin insert wrapper that turns
     SQLSTATE 23P01 into SLOT_TAKEN. */
  function book(state, opts) {
    var salon = getSalon(state, opts.salonId);
    var svc = getService(state, opts.serviceId);
    var start = new Date(opts.startISO);
    var day = ymd(start);
    var end = new Date(start.getTime() + svc.durationMin * MIN);
    var bufferUntil = new Date(end.getTime() + svc.bufferMin * MIN);

    var candidates = capableStaff(state, opts.salonId, opts.serviceId, opts.staffId);
    if (!candidates.length) { return { ok: false, code: 'NO_STAFF', message: NO_STAFF_MESSAGE }; }
    if (opts.preferStaffId) {
      candidates = candidates.slice().sort(function (a, b) {
        return (b.id === opts.preferStaffId ? 1 : 0) - (a.id === opts.preferStaffId ? 1 : 0);
      });
    }

    var chosen = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var st = candidates[i];
      var startMin = start.getHours() * 60 + start.getMinutes();
      var need = svc.durationMin + svc.bufferMin;
      var inside = staffWindows(st, salon, day).some(function (w) {
        return w.start <= startMin && w.end >= startMin + need;
      });
      if (!inside) { continue; }
      var clash = activeOn(state, st.id, day).some(function (a) {
        return overlap(start.getTime(), bufferUntil.getTime(), a.startsAt.getTime(), a.bufferUntil.getTime());
      });
      if (clash) { continue; }
      chosen = st;
      break;
    }

    if (!chosen) { return { ok: false, code: 'SLOT_TAKEN', message: SLOT_TAKEN_MESSAGE }; }

    var appt = {
      id: 'appt-' + (state.appointments.length + 1) + '-' + Date.now(),
      ref: makeRef(), salonId: opts.salonId, staffId: chosen.id, serviceId: svc.id,
      customerName: opts.customer.name, customerPhone: opts.customer.phone, customerEmail: opts.customer.email,
      note: opts.customer.note || '',
      startsAt: start, endsAt: end, bufferUntil: bufferUntil,
      status: 'booked', price: svc.price, day: day,
      cancelledAt: null
    };
    state.appointments.push(appt);
    return { ok: true, appointment: appt, staff: chosen, service: svc, salon: salon };
  }

  function cancel(state, ref) {
    var appt = state.appointments.filter(function (a) { return a.ref === ref; })[0];
    if (!appt) { return { ok: false, code: 'NOT_FOUND' }; }
    appt.status = 'cancelled';
    appt.cancelledAt = new Date();
    return { ok: true, appointment: appt };
  }

  /* Who can actually take this service, ignoring hours. Used by the UI to explain
     an empty day instead of just showing nothing. */
  function canDo(state, staffId, serviceId) {
    var st = getStaff(state, staffId);
    return !!st && st.services.indexOf(serviceId) >= 0;
  }

  return {
    MIN: MIN,
    SLOT_TAKEN_MESSAGE: SLOT_TAKEN_MESSAGE,
    DAY_NAMES: DAY_NAMES,
    createState: createState,
    getSalon: getSalon, getService: getService, getStaff: getStaff,
    servicesForSalon: servicesForSalon, staffForSalon: staffForSalon, eligibleStaff: eligibleStaff,
    capableStaff: capableStaff,
    staffWindows: staffWindows, availableSlots: availableSlots, nextDays: nextDays,
    earliestSlot: earliestSlot,
    book: book, cancel: cancel, canDo: canDo,
    overlap: overlap, parseWindows: parseWindows, subtract: subtract, intersect: intersect,
    ymd: ymd, parseYmd: parseYmd, todayYmd: todayYmd, addDays: addDays, weekdayOf: weekdayOf,
    atMinutes: atMinutes, minutesOfDay: minutesOfDay, hmOfMinutes: hmOfMinutes,
    minutesOfDate: minutesOfDate, diaryLanes: diaryLanes,
    clockLabel: clockLabel, durationLabel: durationLabel, formatINR: formatINR, dateParts: dateParts
  };
}());

if (typeof module !== 'undefined' && module.exports) { module.exports = GH; }
