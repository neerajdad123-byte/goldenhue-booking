/* Drives the served site in a real browser and checks that it is genuinely talking
   to the server: the badge, the availability, the write, and the live push.
   Usage: node work/live-test.js <cdp-port> [base] */
var PORT = process.argv[2] || '9222';
var BASE = process.argv[3] || 'http://localhost:3000/';
var pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function rpc(ws, st, method, params) {
  const id = ++st.id;
  return new Promise(function (resolve, reject) {
    function onMsg(ev) {
      var m = JSON.parse(ev.data);
      if (m.id !== id) { return; }
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function once(ws, event) {
  return new Promise(function (resolve) {
    function onMsg(ev) {
      var m = JSON.parse(ev.data);
      if (m.method !== event) { return; }
      ws.removeEventListener('message', onMsg);
      resolve(m.params);
    }
    ws.addEventListener('message', onMsg);
  });
}

/* Never wait on a browser event forever. A missed load event should cost a
   second, not the whole run. */
function onceOrTimeout(ws, event, ms) {
  return Promise.race([
    once(ws, event),
    new Promise(function (r) { setTimeout(r, ms || 12000); })
  ]);
}

/* One-shot calls on the browser endpoint, which stays available even when every
   page has been closed. Used to tidy up and then open a fresh tab. */
async function rpc2(port, method, params) {
  var version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  var ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  var out = await rpc(ws, st, method, params);
  ws.close();
  return out;
}

(async function () {
  /* Start from a clean browser: leftover tabs each hold a push stream, and a
     browser caps concurrent connections per host. */
  var stale = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  for (var t of stale) {
    /* every page, not just this app: any tab can be holding a connection, and a
       browser only allows a handful per host */
    if (t.type === 'page' && (t.url || '').indexOf('devtools://') !== 0) {
      await rpc2(PORT, 'Target.closeTarget', { targetId: t.id }).catch(function () {});
    }
  }
  await new Promise(function (r) { setTimeout(r, 400); });
  var opened = await rpc2(PORT, 'Target.createTarget', { url: BASE });
  await new Promise(function (r) { setTimeout(r, 2000); });

  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.id === opened.targetId; })[0] ||
             list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Runtime.enable');
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });

  async function go(url) {
    /* a missed load event should cost seconds, not the whole run */
    var loaded = onceOrTimeout(ws, 'Page.loadEventFired', 15000);
    await rpc(ws, st, 'Page.navigate', { url: url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,1400)))', awaitPromise: true });
  }
  async function ev(expr) {
    var r = await withTimeout(rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      20000, 'page evaluate timed out: ' + expr.slice(0, 60));
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception.description); }
    return r.result.value;
  }

  /* A page that is waiting on a connection that will never come must fail the
     check, not stall the run. */
  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error(message)); }, ms); })
    ]);
  }
  var wait = function (ms) { return 'new Promise(r=>setTimeout(r,' + ms + '))'; };

  console.log('the served page knows it is live');
  /* Repeated runs fill the diary, so ask the server which day still has room
     instead of assuming tomorrow is free. */
  async function firstFreeDay(service, staff, days) {
    for (var i = 0; i <= (days || 14); i += 1) {
      var day = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
      var r = await fetch(BASE + 'api/availability?salon=goldenhue&service=' + service + '&staff=' + staff + '&date=' + day).then(function (x) { return x.json(); });
      if (r.slots && r.slots.length) { return { offset: i, day: day, slots: r.slots }; }
    }
    return null;
  }
  var freeDay = await firstFreeDay('gh-haircut', 'ramesh', 14);
  check('some day in the next fortnight still has room', !!freeDay, 'the diary is full for two weeks');
  var RIDE = BASE + '?service=gh-haircut&staff=ramesh&day=' + freeDay.offset + '&step=3';

  await go(BASE);
  check('the badge reads Live', (await ev('document.getElementById("liveBadge").textContent')) === 'Live',
    await ev('document.getElementById("liveBadge").textContent'));
  check('the badge is no longer hidden', (await ev('document.getElementById("liveBadge").hidden')) === false);
  check('the catalogue came from the server', (await ev('document.querySelectorAll(".menu-item").length')) === 5);
  check('no page errors', (await ev('window.__errs ? window.__errs.length : 0')) === 0);

  console.log('availability is served, per stylist');
  await ev('document.querySelector(".menu-item").click(); ' + wait(700));
  check('the crew list appeared', (await ev('document.querySelectorAll(".crew-item").length')) > 1);
  await ev(wait(900));
  var nextTexts = await ev('Array.from(document.querySelectorAll(".crew-item .crew-next")).map(e => e.textContent).filter(Boolean).join(" | ")');
  check('each stylist shows when they are next free', /Next free|fortnight/.test(nextTexts), nextTexts.slice(0, 120));
  check('the soonest chair was computed', /\d:\d\d [AP]M/.test(await ev('document.getElementById("nextFreeText").textContent')),
    await ev('document.getElementById("nextFreeText").textContent'));

  console.log('a real booking is written to the database');
  var before = await ev('fetch("api/appointments-range?salon=goldenhue&from=' + new Date().toISOString().slice(0,10) + '&to=' + new Date(Date.now()+15*864e5).toISOString().slice(0,10) + '").then(r=>r.json()).then(j=>j.appointments.length)');
  await go(RIDE);
  check('the diary opened', (await ev('!document.getElementById("panel-3").hidden')) === true);
  check('the rail has free bars', (await ev('document.querySelectorAll(".blk-free").length')) > 0);
  var chosen = await ev('(() => { const b = document.querySelector(".blk-free"); b.click(); return b.dataset.start; })()');
  await ev(wait(700));
  await ev('document.querySelector("[data-action=continue]").click(); ' + wait(500));
  await ev('(() => { document.getElementById("fName").value = "Live Person"; document.getElementById("fPhone").value = "9876512345"; })(); ' + wait(100));
  await ev('document.getElementById("detailsForm").requestSubmit(); ' + wait(1400));
  check('the booking was accepted', (await ev('!document.getElementById("panel-5").hidden')) === true,
    await ev('document.getElementById("toast").textContent'));
  var ref = await ev('document.getElementById("stubRef").textContent');
  check('the reference came from the server', /^GH-[A-Z0-9]{6}$/.test(ref), ref);
  var after = await ev('fetch("api/appointments-range?salon=goldenhue&from=' + new Date().toISOString().slice(0,10) + '&to=' + new Date(Date.now()+15*864e5).toISOString().slice(0,10) + '").then(r=>r.json()).then(j=>j.appointments.length)');
  check('the database now holds one more appointment', after === before + 1, before + ' -> ' + after);
  var stored = await ev('fetch("api/appointments?salon=goldenhue&date=" + ' + JSON.stringify(chosen.slice(0, 10)) + ').then(r=>r.json()).then(j=>j.appointments.some(a => a.ref === ' + JSON.stringify(ref) + '))');
  check('and it is retrievable by reference', stored === true);

  console.log('the booking is live in another tab');
  var other = await rpc(ws, st, 'Target.createTarget', { url: RIDE });
  await new Promise(function (r) { setTimeout(r, 2500); });
  var tabs = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var second = tabs.filter(function (t) { return t.id === other.targetId; })[0];
  var ws2 = new WebSocket(second.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws2.onopen = res; ws2.onerror = function () { rej(new Error('ws2')); }; });
  var st2 = { id: 1 };
  await rpc(ws2, st2, 'Runtime.enable');
  async function ev2(expr) {
    var r = await rpc(ws2, st2, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception.description); }
    return r.result.value;
  }
  check('the second tab is live too', (await ev2('document.getElementById("liveBadge").textContent')) === 'Live');
  var barsBefore = await ev('document.querySelectorAll(".blk-free").length');
  var conflict = await ev2('fetch("api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ salonId: "goldenhue", serviceId: "gh-haircut", staffId: "ramesh", startISO: ' + JSON.stringify(chosen) + ', customer: { name: "Second Tab", phone: "9876500000" } }) }).then(r => r.json().then(b => ({ status: r.status, message: b.message })))');
  check('the same slot is refused for the second tab', conflict.status === 409, JSON.stringify(conflict));

  /* A refused booking is not broadcast, so make a real one from the second tab and
     watch the first tab, which is sitting on an open stream, learn about it. */
  var bar = await ev2('(() => { const b = document.querySelector(".blk-free"); return b ? { start: b.dataset.start, staff: b.dataset.staff } : null; })()');
  check('the second tab has a free bar to take', !!bar, 'none found');
  var took = await ev2('fetch("api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ salonId: "goldenhue", serviceId: "gh-haircut", staffId: ' + JSON.stringify(bar.staff) + ', startISO: ' + JSON.stringify(bar.start) + ', customer: { name: "Cross Tab", phone: "9876500001" } }) }).then(r => r.status)');
  check('the second tab books it', took === 201, String(took));
  await new Promise(function (r) { setTimeout(r, 1800); });
  var toastText = await ev('document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent');
  check('the first tab is told without a refresh', /Just booked|Just freed/.test(toastText), toastText.slice(0, 110));
  /* Counting bars is brittle: a booking in the middle of a long free window splits
     it in two and the total can stay the same. Ask about the exact bar instead. */
  var stillOffered = await ev('!!document.querySelector(\'.blk-free[data-start="\' + ' + JSON.stringify(bar.start) + ' + \'"][data-staff="\' + ' + JSON.stringify(bar.staff) + ' + \'"]\')');
  check('and the bar it took is gone from the first tab', stillOffered === false, 'still offered');
  var barsAfter = await ev('document.querySelectorAll(".blk-free").length');
  check('the diary redrew at all', barsAfter > 0, barsBefore + ' -> ' + barsAfter);

  console.log('cancelling frees it again');
  var cancelled = await ev('fetch("api/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: ' + JSON.stringify(ref) + ' }) }).then(r=>r.status)');
  check('the server accepts the cancellation', cancelled === 200, String(cancelled));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (other && other.targetId) { await rpc(ws, st, 'Target.closeTarget', { targetId: other.targetId }).catch(function () {}); }
  ws.close(); ws2.close();
  process.exit(fail ? 1 : 0);
}()).catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
