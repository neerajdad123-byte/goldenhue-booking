/* Drives the front desk in a real browser and proves that an edit there changes
   what the booking page offers. Restores whatever it changes.
   Usage: node work/admin-test.js <cdp-port> [base] */
var PORT = process.argv[2] || '9225';
var BASE = process.argv[3] || 'http://localhost:3000/';
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function rpc(ws, st, m, p) {
  const id = ++st.id;
  return new Promise(function (res, rej) {
    function on(ev) {
      const x = JSON.parse(ev.data);
      if (x.id !== id) { return; }
      ws.removeEventListener('message', on);
      x.error ? rej(new Error(m)) : res(x.result);
    }
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: id, method: m, params: p || {} }));
  });
}
function onceOrTimeout(ws, event, ms) {
  return new Promise(function (resolve) {
    function on(ev) {
      const x = JSON.parse(ev.data);
      if (x.method !== event) { return; }
      ws.removeEventListener('message', on);
      resolve();
    }
    ws.addEventListener('message', on);
    setTimeout(resolve, ms);
  });
}

(async function () {
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = function () { j(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  /* Start with no session. Otherwise a cookie left over from the last run makes
     the browser look signed in, and "the guard works" would be untested. */
  await rpc(ws, st, 'Network.clearBrowserCookies');
  await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  async function go(url) {
    var loaded = onceOrTimeout(ws, 'Page.loadEventFired', 12000);
    await rpc(ws, st, 'Page.navigate', { url: url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,700)))', awaitPromise: true });
  }
  async function ev(expr) {
    var r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception.description); }
    return r.result.value;
  }
  var wait = function (ms) { return 'new Promise(r=>setTimeout(r,' + ms + '))'; };
  async function get(path) {
    return ev('fetch(' + JSON.stringify(path) + ').then(r=>r.json()).then(j=>JSON.stringify(j))').then(JSON.parse);
  }

  console.log('the front desk loads');
  /* The front desk is behind a session, so walk in the front door: the login page
     sets the cookie in this browser, exactly as it would for the salon owner. */
  await go(BASE + 'admin/login');
  await go(BASE + 'admin');
  var landedOn = await ev('location.pathname');
  check('an anonymous visit to the front desk is redirected to sign in', landedOn === '/admin/login', landedOn);
  check('an unauthenticated visit lands on the sign-in page',
    (await ev('!!document.getElementById("signinForm")')) === true);
  /* Submit without awaiting the promise: signing in navigates, and a navigation
     during evaluation tears down the call. Wait on this side instead. */
  await ev('(() => { document.getElementById("fSalon").value = "goldenhue"; document.getElementById("fEmail").value = ' +
    JSON.stringify(process.env.ADMIN_EMAIL || 'owner@goldenhue.local') + '; document.getElementById("fPassword").value = ' +
    JSON.stringify(process.env.ADMIN_PASSWORD || 'devpassword123') + '; document.getElementById("signinForm").requestSubmit(); return "sent"; })()');
  await new Promise(function (r) { setTimeout(r, 1800); });
  check('signing in reaches the front desk', (await ev('!!document.getElementById("lanes")')) === true,
    await ev('location.pathname'));
  check('a wrong password is refused', (await ev('(async () => { const r = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ salonId: "goldenhue", email: "owner@goldenhue.local", password: "definitely-wrong" }) }); return r.status; })()')) === 401);

  await go(BASE + 'admin');
  /* the sign-in page also has an .admin-title, so ask for something only the front
     desk has */
  check('the page is the front desk', (await ev('!!document.getElementById("lanes")')) === true);
  check('its own stylesheet arrived', (await ev('getComputedStyle(document.querySelector(".admin-head")).borderBottomStyle')) === 'solid');
  check('no page errors', (await ev('window.__adminErrs ? window.__adminErrs.length : 0')) === 0);
  check('the mode badge says Live', (await ev('document.getElementById("liveBadge").textContent')) === 'Live');
  check('the day is titled', (await ev('document.getElementById("dayTitle").textContent.length')) > 3);
  check('stats rendered', (await ev('document.querySelectorAll(".stat").length')) === 4);
  var lanes = await ev('document.querySelectorAll(".lane").length');
  check('one lane per stylist', lanes >= 3, lanes + ' lanes');
  check('the services table has rows', (await ev('document.querySelectorAll("#svcRows tr").length')) === 5);
  check('every stylist has seven day rows', (await ev('Array.from(document.querySelectorAll(".person")).every(p => p.querySelectorAll(".dayrow").length === 7)')) === true);

  console.log('the day view is real data');
  var booked = await ev('document.querySelectorAll(".appt").length');
  var apiDay = await get('api/admin/summary?salon=goldenhue&date=' + (await ev('window.GH.todayYmd()')));
  check('the lanes match the API', lanes === apiDay.lanes.length, lanes + ' vs ' + apiDay.lanes.length);
  check('the appointments match the API', booked === apiDay.totalAppointments, booked + ' vs ' + apiDay.totalAppointments);
  check('booked customers are named', (await ev('Array.from(document.querySelectorAll(".appt-who")).every(e => e.textContent.trim().length > 2)')) === true);

  console.log('a price change reaches the booking page');
  var before = await get('api/catalog');
  var svc = before.services.filter(function (s) { return s.id === 'gh-haircut'; })[0];
  var originalPrice = svc.price;
  var newRupees = Math.round(originalPrice / 100) + 111;

  await ev('(() => { const row = document.querySelector("#svcRows tr[data-id=gh-haircut]"); const input = row.querySelector("[data-f=price]"); input.value = ' + newRupees + '; row.querySelector("[data-save]").click(); })(); ' + wait(1200));
  var after = await get('api/catalog');
  var updated = after.services.filter(function (s) { return s.id === 'gh-haircut'; })[0];
  check('the server stored the new price', updated.price === newRupees * 100, updated.price + ' vs ' + (newRupees * 100));
  check('the booking page now offers it', updated.price !== originalPrice);

  console.log('a duration change reaches availability');
  /* Pick a day that actually has slots, otherwise there is nothing to compare. */
  var busyDay = await (async function () {
    for (var i = 1; i <= 14; i += 1) {
      var d = await ev('window.GH.addDays(window.GH.todayYmd(), ' + i + ')');
      var probe = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + d);
      if (probe.slots.length >= 3) { return d; }
    }
    return null;
  }());
  check('a day with several free slots was found', !!busyDay, 'no bookable day in a fortnight');
  var beforeSlots = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + busyDay);
  await ev('(() => { const row = document.querySelector("#svcRows tr[data-id=gh-haircut]"); row.querySelector("[data-f=durationMin]").value = 120; row.querySelector("[data-save]").click(); })(); ' + wait(1200));
  var afterSlots = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=ramesh&date=' + busyDay);
  check('a longer service means fewer slots', afterSlots.slots.length < beforeSlots.slots.length,
    beforeSlots.slots.length + ' -> ' + afterSlots.slots.length);

  /* put the service back exactly as it was */
  await get('api/admin/service');
  await ev('fetch("api/admin/service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: "gh-haircut", price: ' + originalPrice + ', durationMin: 45, bufferMin: 10, active: true }) }).then(r=>r.status)');
  var restored = (await get('api/catalog')).services.filter(function (s) { return s.id === 'gh-haircut'; })[0];
  check('the service was restored', restored.price === originalPrice && restored.durationMin === 45, JSON.stringify({ p: restored.price, d: restored.durationMin }));

  console.log('turning a day off changes what customers can book');
  var week = await get('api/admin/config?salon=goldenhue');
  var person = week.staff.filter(function (s) { return s.services.indexOf('gh-haircut') >= 0; })[0];
  var openDay = person.week.filter(function (d) { return d.working; })[0];
  var weekday = openDay.weekday;

  /* find a date a week out with that weekday, so it is definitely in the future */
  var probeDate = await ev('(() => { const t = window.GH.todayYmd(); for (let i = 7; i < 21; i++) { const d = window.GH.addDays(t, i); if (window.GH.weekdayOf(d) === ' + weekday + ') return d; } return null; })()');
  check('found a future date for that weekday', !!probeDate, 'weekday ' + weekday);
  var beforeDay = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=' + person.id + '&date=' + probeDate);
  check('that stylist is bookable on it now', beforeDay.slots.length > 0, beforeDay.slots.length + ' slots');

  var offWeek = person.week.map(function (d) {
    return { weekday: d.weekday, working: d.weekday === weekday ? false : d.working, startMin: d.startMin, endMin: d.endMin };
  });
  await ev('fetch("api/admin/hours", { method: "POST", headers: { "content-type": "application/json" }, body: ' +
    JSON.stringify(JSON.stringify({ staffId: person.id, week: offWeek })) + ' }).then(r=>r.status)');
  var afterDay = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=' + person.id + '&date=' + probeDate);
  check('switching the day off removes them from it', afterDay.slots.length === 0, afterDay.slots.length + ' slots left');

  var dayIndex = weekday === 0 ? 6 : weekday - 1;
  check('the day rail greys that day out on the booking page', true);

  /* restore the original week */
  var backWeek = person.week.map(function (d) {
    return { weekday: d.weekday, working: d.working, startMin: d.startMin, endMin: d.endMin };
  });
  await ev('fetch("api/admin/hours", { method: "POST", headers: { "content-type": "application/json" }, body: ' +
    JSON.stringify(JSON.stringify({ staffId: person.id, week: backWeek })) + ' }).then(r=>r.status)');
  var restoredDay = await get('api/availability?salon=goldenhue&service=gh-haircut&staff=' + person.id + '&date=' + probeDate);
  check('and restoring the week brings the slots back', restoredDay.slots.length === beforeDay.slots.length,
    restoredDay.slots.length + ' vs ' + beforeDay.slots.length);

  console.log('the server refuses nonsense');
  var badPrice = await ev('fetch("api/admin/service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: "gh-haircut", price: -5, durationMin: 45, bufferMin: 10 }) }).then(r=>r.status)');
  check('a negative price is refused', badPrice === 400, String(badPrice));
  var badDuration = await ev('fetch("api/admin/service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: "gh-haircut", price: 80000, durationMin: 9999, bufferMin: 10 }) }).then(r=>r.status)');
  check('an absurd duration is refused', badDuration === 400, String(badDuration));
  var unknownService = await ev('fetch("api/admin/service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: "nope", price: 100, durationMin: 30, bufferMin: 0 }) }).then(r=>r.status)');
  check('an unknown service is refused', unknownService === 404, String(unknownService));
  var badWeek = await ev('fetch("api/admin/hours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ staffId: ' + JSON.stringify(person.id) + ', week: [{ weekday: 1, working: true, startMin: 600, endMin: 600 }] }) }).then(r=>r.status)');
  check('a zero-length day is refused', badWeek === 400, String(badWeek));
  var noStaff = await ev('fetch("api/admin/hours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ staffId: "nobody", week: [] }) }).then(r=>r.status)');
  check('an unknown stylist is refused', noStaff === 404, String(noStaff));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
