/* The front desk. Reads and writes the salon's own settings through the server, so
   an edit here changes what the booking page offers on the next request.

   Everything is validated on the server as well: this page is a convenience, not
   the thing standing between a typo and a broken diary. */
(function () {
  'use strict';

  var E = GH;
  var state = null;      /* the day summary */
  var config = null;     /* services and hours */
  var ui = { salonId: null, date: E.todayYmd(), live: false, stream: null };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(paise) { return E.formatINR(paise); }

  async function api(path, options) {
    var r = await fetch(path, options);
    /* The session can expire while the page is open. Send them to sign in rather
       than leaving a front desk that silently cannot save anything. */
    if (r.status === 401 && String(path).indexOf('admin') >= 0 && String(path).indexOf('login') < 0) {
      window.location.replace('/admin/login');
      throw new Error('signed out');
    }
    var body = await r.json().catch(function () { return {}; });
    return { status: r.status, body: body };
  }

  var toastTimer = null;
  function toast(message, kind) {
    var t = el('toast');
    t.textContent = message;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }

  /* ---------- the day ---------- */

  function dayLabel(date) {
    var p = E.dateParts(date);
    var today = E.todayYmd();
    if (date === today) { return 'Today'; }
    if (date === E.addDays(today, 1)) { return 'Tomorrow'; }
    if (date === E.addDays(today, -1)) { return 'Yesterday'; }
    return E.DAY_NAMES[E.weekdayOf(date)] + ', ' + p.day + ' ' + p.month;
  }

  function shiftDay(delta) {
    ui.date = E.addDays(ui.date, delta);
    loadDay();
  }

  async function loadDay() {
    var res = await api('/api/admin/summary?salon=' + encodeURIComponent(ui.salonId) + '&date=' + ui.date);
    if (res.status !== 200) { toast(res.body.error || 'Could not load the day.', 'error'); return; }
    state = res.body;
    renderDay();
  }

  function renderDay() {
    if (!state) { return; }
    el('dayTitle').textContent = dayLabel(state.date);
    var working = state.lanes.filter(function (l) { return l.working; }).length;
    el('daySub').textContent = state.lanes.length + ' stylists, ' + working + ' in today. ' +
      (state.totalAppointments ? 'Times below are booked and not available.' : 'Nothing booked yet.');

    var booked = state.lanes.reduce(function (n, l) { return n + l.appointments.length; }, 0);
    var mins = state.lanes.reduce(function (n, l) { return n + l.bookedMinutes; }, 0);
    el('stats').innerHTML = [
      ['Appointments', String(booked), booked === 1 ? 'one booking' : booked + ' bookings'],
      ['Taken', E.durationLabel(mins), 'chair time already sold'],
      ['Expected', money(state.revenue), 'before any walk-ins'],
      ['In today', working + ' of ' + state.lanes.length, 'stylists working']
    ].map(function (s) {
      return '<div class="stat"><p class="k">' + esc(s[0]) + '</p><p class="v">' + esc(s[1]) + '</p><p class="n">' + esc(s[2]) + '</p></div>';
    }).join('');

    el('lanes').innerHTML = state.lanes.map(function (lane) {
      var body;
      /* Bookings come first, always. A stylist can have appointments on a day they
         are no longer scheduled to work: someone changed their week, or added
         holiday, after the booking was taken. Hiding those would send a customer to
         a closed door with nothing on the front desk to explain it, so they are
         shown with a warning instead. */
      var appts = lane.appointments.map(function (a) {
          var svc = (config && config.services.filter(function (s) { return s.id === a.serviceId; })[0]) || {};
          return '<article class="appt">' +
            '<p class="appt-time">' + E.clockLabel(a.startMin) + '</p>' +
            '<div><p class="appt-what">' + esc(svc.name || a.serviceId) + '</p>' +
            '<p class="appt-who">' + esc(a.customerName || 'Walk-in') +
              (a.customerPhone ? ' &middot; ' + esc(a.customerPhone) : '') + '</p>' +
            '<p class="appt-ref">' + esc(a.ref) + ' &middot; ' + money(a.price) + '</p></div>' +
          '</article>';
        }).join('');

      if (lane.appointments.length) {
        body = (lane.working ? '' :
          '<p class="lane-warn">Not scheduled to work, but has ' +
          (lane.appointments.length === 1 ? 'a booking' : lane.appointments.length + ' bookings') +
          '. Either cover it or call them.</p>') + appts;
      } else if (!lane.working) {
        body = '<p class="lane-off">Not working this day</p>';
      } else {
        body = '<p class="lane-empty">Nothing booked. The whole day is open.</p>';
      }
      return '<div class="lane' + (lane.working ? '' : ' off') + '">' +
        '<div class="lane-top"><div><p class="lane-name">' + esc(lane.name) + '</p>' +
          '<p class="lane-hours">' + esc(lane.hours || 'not working') + '</p></div>' +
          '<p class="lane-load">' + (lane.bookedMinutes ? E.durationLabel(lane.bookedMinutes) + ' sold' : 'free') + '</p></div>' +
        '<div class="lane-body">' + body + '</div></div>';
    }).join('');
  }

  /* ---------- services ---------- */

  async function loadConfig() {
    var res = await api('/api/admin/config?salon=' + encodeURIComponent(ui.salonId));
    if (res.status !== 200) { return; }
    config = res.body;
    renderServices();
    renderHours();
  }

  function renderServices() {
    if (!config) { return; }
    el('svcRows').innerHTML = config.services.map(function (s) {
      return '<tr data-id="' + esc(s.id) + '">' +
        '<td><span class="name">' + esc(s.name) + '</span><span class="cat">' + esc(s.category) + '</span></td>' +
        '<td><span class="money"><span>&#8377;</span><input class="num" data-f="price" type="number" min="0" step="50" value="' + Math.round(s.price / 100) + '" inputmode="numeric"></span></td>' +
        '<td><input class="num" data-f="durationMin" type="number" min="5" max="600" step="5" value="' + s.durationMin + '" inputmode="numeric"></td>' +
        '<td><input class="num" data-f="bufferMin" type="number" min="0" max="120" step="5" value="' + s.bufferMin + '" inputmode="numeric"></td>' +
        '<td><label class="toggle"><input type="checkbox" data-f="active"' + (s.active ? ' checked' : '') + '><span>taking bookings</span></label></td>' +
        '<td><button type="button" class="btn" data-save="' + esc(s.id) + '">Save</button></td>' +
      '</tr>';
    }).join('');
  }

  function rowFor(id) { return el('svcRows').querySelector('tr[data-id="' + id + '"]'); }

  async function saveService(id) {
    var row = rowFor(id);
    if (!row) { return; }
    var rupees = Number(row.querySelector('[data-f=price]').value);
    var payload = {
      serviceId: id,
      price: Math.round(rupees * 100),
      durationMin: Number(row.querySelector('[data-f=durationMin]').value),
      bufferMin: Number(row.querySelector('[data-f=bufferMin]').value),
      active: row.querySelector('[data-f=active]').checked
    };
    var btn = row.querySelector('[data-save]');
    btn.disabled = true;
    var res = await api('/api/admin/service', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    btn.disabled = false;
    var err = el('svcError');
    if (res.status !== 200) {
      err.textContent = res.body.error || 'That did not save.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    toast('Saved. The booking page is already offering the new price.', 'info');
    await loadConfig();
    await loadDay();
  }

  /* ---------- working hours ---------- */

  function minutesToTime(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function timeToMinutes(value) {
    var p = String(value || '').split(':');
    if (p.length < 2) { return NaN; }
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function renderHours() {
    if (!config) { return; }
    el('hours').innerHTML = config.staff.map(function (st) {
      var tags = st.services.map(function (id) {
        var svc = config.services.filter(function (s) { return s.id === id; })[0];
        return '<span class="tag">' + esc(svc ? svc.name : id) + '</span>';
      }).join('');
      var days = st.week.map(function (d) {
        return '<div class="dayrow' + (d.working ? '' : ' off') + '" data-wd="' + d.weekday + '">' +
          '<span class="d">' + esc(E.DAY_NAMES[d.weekday]) + '</span>' +
          '<label class="toggle"><input type="checkbox" data-w="on"' + (d.working ? ' checked' : '') + '><span>' + (d.working ? 'in' : 'off') + '</span></label>' +
          '<span class="times">' +
            '<input class="time" data-w="from" type="time" value="' + minutesToTime(d.startMin) + '" aria-label="' + esc(E.DAY_NAMES[d.weekday]) + ' start">' +
            '<span class="to">to</span>' +
            '<input class="time" data-w="to" type="time" value="' + minutesToTime(d.endMin) + '" aria-label="' + esc(E.DAY_NAMES[d.weekday]) + ' end">' +
          '</span></div>';
      }).join('');
      return '<div class="person" data-staff="' + esc(st.id) + '">' +
        '<div class="person-top"><div><p class="person-name">' + esc(st.name) + '</p>' +
          '<p class="lane-hours">' + esc(st.title) + '</p></div>' +
          '<div class="person-tags">' + tags + '</div>' +
          '<button type="button" class="btn" data-savehours="' + esc(st.id) + '">Save week</button></div>' +
        '<div class="days">' + days + '</div></div>';
    }).join('');
  }

  async function saveHours(staffId) {
    var person = el('hours').querySelector('.person[data-staff="' + staffId + '"]');
    if (!person) { return; }
    var week = Array.prototype.map.call(person.querySelectorAll('.dayrow'), function (row) {
      var on = row.querySelector('[data-w=on]').checked;
      return {
        weekday: Number(row.dataset.wd),
        working: on,
        startMin: timeToMinutes(row.querySelector('[data-w=from]').value),
        endMin: timeToMinutes(row.querySelector('[data-w=to]').value)
      };
    });
    for (var d of week) {
      if (d.working && (!(d.startMin >= 0) || !(d.endMin > d.startMin))) {
        toast('Check ' + E.DAY_NAMES[d.weekday] + ': the end has to be after the start.', 'error');
        return;
      }
    }
    var btn = person.querySelector('[data-savehours]');
    btn.disabled = true;
    var res = await api('/api/admin/hours', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffId: staffId, week: week })
    });
    btn.disabled = false;
    if (res.status !== 200) { toast(res.body.error || 'Those hours did not save.', 'error'); return; }
    toast('Week saved. Availability has already changed.', 'info');
    await loadConfig();
    await loadDay();
  }

  /* ---------- wiring ---------- */

  function wire() {
    el('prevDay').addEventListener('click', function () { shiftDay(-1); });
    el('nextDay').addEventListener('click', function () { shiftDay(1); });
    el('todayBtn').addEventListener('click', function () { ui.date = E.todayYmd(); loadDay(); });

    el('svcRows').addEventListener('click', function (e) {
      var b = e.target.closest('[data-save]');
      if (b) { saveService(b.dataset.save); }
    });
    el('hours').addEventListener('click', function (e) {
      var b = e.target.closest('[data-savehours]');
      if (b) { saveHours(b.dataset.savehours); }
    });
    /* a day switched off should look switched off straight away */
    el('hours').addEventListener('change', function (e) {
      var box = e.target.closest('[data-w=on]');
      if (!box) { return; }
      var row = box.closest('.dayrow');
      row.classList.toggle('off', !box.checked);
      row.querySelector('.toggle span').textContent = box.checked ? 'in' : 'off';
    });

    el('salonPicker').addEventListener('change', function (e) {
      ui.salonId = e.target.value;
      if (ui.stream) { ui.stream.close(); ui.stream = null; }
      loadConfig();
      loadDay();
      connectStream();
    });
  }

  /* A booking made on the phone in the salon's hand should show up here without
     anyone refreshing the front desk screen. */
  function connectStream() {
    if (typeof EventSource === 'undefined') { return; }
    if (ui.stream) { ui.stream.close(); ui.stream = null; }
    var es = new EventSource('/api/stream?salon=' + encodeURIComponent(ui.salonId));
    ui.stream = es;
    es.onopen = function () { el('liveBadge').hidden = false; el('liveBadge').textContent = 'Live'; el('liveBadge').classList.remove('off'); };
    es.onmessage = function (event) {
      var payload;
      try { payload = JSON.parse(event.data); } catch (err) { return; }
      if (!payload || payload.type === 'hello') { return; }
      if (ui.pending) { clearTimeout(ui.pending); }
      ui.pending = setTimeout(function () {
        ui.pending = null;
        loadDay();
        if (payload.type === 'settings') { loadConfig(); }
      }, 200);
    };
    es.onerror = function () {
      el('liveBadge').hidden = false;
      el('liveBadge').textContent = 'Reconnecting';
      el('liveBadge').classList.add('off');
    };
  }

  async function boot() {
    el('signOut').addEventListener('click', function () {
      fetch('/api/admin/logout', { method: 'POST' }).then(function () { window.location.replace('/admin/login'); });
    });

    var cat = await api('/api/catalog');
    if (cat.status !== 200 || !cat.body.salons || !cat.body.salons.length) {
      document.body.innerHTML = '<div class="empty" style="margin:40px auto;max-width:520px">' +
        '<strong>The front desk needs the server</strong>' +
        '<p>Start it with <code>node outputs/demo/server.js</code> and open this page again.</p></div>';
      return;
    }
    GH = GH; /* the engine is already loaded as a global */
    ui.salonId = cat.body.salons[0].id;
    el('liveBadge').hidden = false;
    el('liveBadge').textContent = 'Live';
    var picker = el('salonPicker');
    picker.innerHTML = cat.body.salons.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
    }).join('');
    picker.value = ui.salonId;
    el('adminSalon').textContent = cat.body.salons[0].name + ' · front desk';
    wire();
    await loadConfig();
    await loadDay();
    connectStream();
  }

  boot();
}());
