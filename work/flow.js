/* End-to-end check of the demo, driven through the DevTools protocol: it clicks the
   real elements and reads the real panel state. Usage: node work/flow.js <port> */
var PORT = process.argv[2] || '9222';
var BASE = 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/index.html';
var pass = 0, fail = 0;

function rpc(ws, st, method, params) {
  const id = ++st.id;
  return new Promise(function (resolve, reject) {
    function onMsg(ev) {
      var msg = JSON.parse(ev.data);
      if (msg.id !== id) { return; }
      ws.removeEventListener('message', onMsg);
      msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function once(ws, event) {
  return new Promise(function (resolve) {
    function onMsg(ev) {
      var msg = JSON.parse(ev.data);
      if (msg.method !== event) { return; }
      ws.removeEventListener('message', onMsg);
      resolve(msg.params);
    }
    ws.addEventListener('message', onMsg);
  });
}
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

(async function () {
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws failed')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  /* file:// resources are cacheable, and testing a stale script is worse than no test */
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

  async function go(url) {
    var loaded = once(ws, 'Page.loadEventFired');
    await rpc(ws, st, 'Page.navigate', { url: url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,600))', awaitPromise: true });
  }
  async function ev(expr) {
    var r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception.description); }
    return r.result.value;
  }
  const sleep = 'new Promise(r=>setTimeout(r,120))';

  console.log('picking a service');
  await go(BASE);
  await ev('document.querySelector(".menu-item").click(); ' + sleep);
  check('step two opens', (await ev('!document.getElementById("panel-2").hidden')) === true);
  check('the tag names the service', (await ev('document.querySelector(".clip-service").textContent')).length > 3);
  check('the crew is filtered to that service', (await ev('document.querySelectorAll(".crew-item").length')) > 1);
  check('the headline advanced', (await ev('document.getElementById("stepHeadline").textContent')) === "Who's doing it?");

  console.log('picking a stylist');
  await ev('document.querySelector(".crew-item").click(); ' + sleep + '; new Promise(r=>setTimeout(r,400))');
  check('step three opens', (await ev('!document.getElementById("panel-3").hidden')) === true);
  check('the day rail is drawn', (await ev('document.querySelectorAll(".day").length')) === 14);
  check('the pill sits on the chosen day', (await ev('(() => { const p = document.getElementById("dayFloat").getBoundingClientRect(), a = document.querySelector(\'.day[aria-pressed="true"]\').getBoundingClientRect(); return Math.abs(p.left - a.left) < 2; })()')) === true);
  check('the rail offers lit bars', (await ev('document.querySelectorAll(".blk-free").length')) > 0);
  check('the tag names the stylist', (await ev('document.querySelector(\'[data-k="stylist"] .v\').textContent')).indexOf('Not picked') === -1);

  console.log('picking a time');
  var railAfter = await ev('document.querySelectorAll(".blk-free").length');
  /* long enough for the flight to land, so it cannot be mistaken for a second bar */
  await ev('document.querySelector(".blk-free").click(); new Promise(r=>setTimeout(r,620))');
  var pressedCount = await ev('document.querySelectorAll(\'.blk-free[aria-pressed="true"]\').length');
  var pressedWho = await ev('Array.from(document.querySelectorAll(\'.blk-free[aria-pressed="true"]\')).map(b => b.dataset.staff + "@" + b.dataset.start.slice(11, 16)).join(" ")');
  check('the chosen bar reads pressed', pressedCount === 1, 'pressed: ' + pressedCount + ' :: ' + pressedWho);
  check('the tag fills in the time', (await ev('document.querySelector(\'[data-k="when"] .v\').textContent')).indexOf('Not picked') === -1);
  check('a continue button appears', (await ev('!!document.querySelector("[data-action=continue]")')) === true);

  console.log('the race the product exists to prevent');
  /* the exact bar under test: same start AND same stylist */
  var pressed = await ev('(() => { const b = document.querySelector(\'.blk-free[aria-pressed="true"]\'); return { start: b.dataset.start, staff: b.dataset.staff }; })()');
  await ev('document.getElementById("rivalBtn").click(); ' + sleep);
  check('the rival booked something', (await ev('!document.getElementById("toast").hidden')) === true);
  var findBar = '((p) => !!document.querySelector(\'.blk-free[data-start="\' + p.start + \'"][data-staff="\' + p.staff + \'"]\'))(' + JSON.stringify(pressed) + ')';
  check('the page was left deliberately stale', (await ev(findBar)) === true);

  console.log('confirming the stale slot');
  await ev('document.querySelector("[data-action=continue]").click(); ' + sleep);
  check('the details panel opens', (await ev('!document.getElementById("panel-4").hidden')) === true);
  await ev('(() => { document.getElementById("fName").value = "Test Person"; document.getElementById("fPhone").value = "9876543210"; document.getElementById("detailsForm").requestSubmit(); })(); new Promise(r=>setTimeout(r,250))');
  var msg = await ev('document.getElementById("toast").textContent');
  check('the server refuses the stale slot', msg.indexOf('just been booked') >= 0, msg);
  check('the customer lands back on the rail', (await ev('!document.getElementById("panel-3").hidden')) === true);
  check('the bar the rival took is gone from the rail', (await ev(findBar)) === false, 'still offering ' + pressed.start);

  console.log('booking a genuinely free slot');
  await ev('document.querySelector(".blk-free").click(); ' + sleep);
  await ev('document.querySelector("[data-action=continue]").click(); ' + sleep);
  await ev('(() => { document.getElementById("fName").value = "Kavya Sharma"; document.getElementById("fPhone").value = "9876500000"; document.getElementById("detailsForm").requestSubmit(); })(); new Promise(r=>setTimeout(r,300))');
  check('the stub appears', (await ev('!document.getElementById("panel-5").hidden')) === true);
  check('the stub carries a reference', (await ev('document.getElementById("stubRef").textContent')).indexOf('GH-') === 0);
  check('the stamp reads confirmed', (await ev('document.getElementById("stubStamp").textContent')) === 'Confirmed');
  check('the stub lists the stylist and the price', (await ev('document.getElementById("stubList").textContent')).indexOf('Total') >= 0);

  console.log('cancelling');
  await ev('document.getElementById("cancelBtn").click(); ' + sleep);
  check('the stamp flips to cancelled', (await ev('document.getElementById("stubStamp").textContent')) === 'Cancelled');
  check('the cancel button goes away', (await ev('document.getElementById("cancelBtn").hidden')) === true);

  console.log('the salon switch repaints the whole page');
  await ev('(() => { const p = document.getElementById("salonPicker"); p.value = "blushbloom"; p.dispatchEvent(new Event("change")); })(); new Promise(r=>setTimeout(r,250))');
  check('the blade sign follows the salon', (await ev('document.querySelector(".blade").textContent')).indexOf('Blush') >= 0);
  check('the brand colour follows the salon', (await ev('getComputedStyle(document.documentElement).getPropertyValue("--brand").trim()')) === '#FF4D8D');
  check('the menu is that salon menu', (await ev('document.querySelector(".menu-name").textContent')) === 'Gel Manicure');
  check('no console errors on the page', (await ev('window.__errs ? window.__errs.length : 0')) === 0);

  console.log('back to step one: the front door');
  /* A shared link should name a real date, not an offset that means a different day
     depending on where it is opened. */
  await go(BASE + '?service=gh-haircut&staff=any&date=2030-01-15&step=3');
  check('an explicit date in a link is honoured exactly',
    (await ev('window.__gh.ui.dateISO')) === '2030-01-15',
    await ev('window.__gh.ui.dateISO'));
  await go(BASE + '?service=gh-haircut&staff=any&date=not-a-date&day=2&step=3');
  check('a malformed date falls back to the offset rather than breaking',
    (await ev('window.__gh.ui.dateISO')) === (await ev('window.GH.addDays(window.GH.todayYmd(), 2)')),
    await ev('window.__gh.ui.dateISO'));

  await go(BASE);
  check('step one leads with the salon own line', (await ev('document.getElementById("stepHeadline").textContent')).indexOf('colour, cuts') >= 0);
  check('the soonest button waits for a service', (await ev('document.getElementById("nextFreeBtn").disabled')) === true);
  check('the filter lists every category', (await ev('document.querySelectorAll(".filter").length')) >= 3);
  check('the reviews band is moving', (await ev('getComputedStyle(document.querySelector(".reviews-run")).animationName')) === 'marquee');
  check('the footer lists the week', (await ev('document.querySelectorAll(".foot li").length')) >= 7);
  check('the footer names the salon', (await ev('document.querySelector(".foot-brand").textContent')).indexOf('Goldenhue') >= 0);

  var allCount = await ev('document.querySelectorAll(".menu-item").length');
  await ev('document.querySelectorAll(".filter")[1].click(); new Promise(r=>setTimeout(r,150))');
  var oneCount = await ev('document.querySelectorAll(".menu-item").length');
  check('filtering narrows the menu', oneCount < allCount, oneCount + ' of ' + allCount);
  await ev('document.querySelectorAll(".filter")[0].click(); new Promise(r=>setTimeout(r,150))');
  check('choosing everything restores the menu', (await ev('document.querySelectorAll(".menu-item").length')) === allCount);

  console.log('the soonest chair shortcut');
  await ev('document.querySelector(".menu-item").click(); new Promise(r=>setTimeout(r,800))');
  var nf = await ev('document.getElementById("nextFreeText").textContent');
  check('the button names a real time', /\d:\d\d [AP]M/.test(nf), nf);
  var nfDisabled = await ev('document.getElementById("nextFreeBtn").disabled');
  check('and it is clickable once a service is picked', nfDisabled === false);
  await ev('document.getElementById("nextFreeBtn").click(); new Promise(r=>setTimeout(r,900))');
  check('it lands on the diary', (await ev('!document.getElementById("panel-3").hidden')) === true);
  check('with the bar it named already chosen', (await ev('!!document.querySelector(\'.blk-free[aria-pressed="true"]\')')) === true);
  check('and the tag carries the time', (await ev('document.querySelector(\'[data-k="when"] .v\').textContent')).indexOf('Not picked') === -1);

  console.log('photography and the follow-the-cursor preview');
  await go(BASE);
  check('the salon photograph has decoded', (await ev('(() => { const i = document.getElementById("coverImg"); return i.complete && i.naturalWidth > 0; })()')) === true);
  check('the cover frame is marked ready', (await ev('document.getElementById("cover").classList.contains("ready")')) === true);
  var shots = await ev('document.querySelectorAll(".shot img").length');
  check('the work band is populated', shots >= 6, shots + ' shots');
  /* the band is lazy and below the fold, so scroll to it the way a person would
     before asking whether its pictures decoded */
  await ev('document.getElementById("gallery").scrollIntoView({ block: "center" }); new Promise(r=>setTimeout(r,900))');
  check('every band picture decoded once scrolled to', (await ev('Array.from(document.querySelectorAll(".shot img")).every(i => i.complete && i.naturalWidth > 0)')) === true);
  check('the headline is masked into words', (await ev('document.querySelectorAll(".headline .w").length')) >= 3);
  check('nothing on screen is a broken image', (await ev('Array.from(document.querySelectorAll("img")).filter(i => { if (!i.getAttribute("src") || i.offsetParent === null) return false; const r = i.getBoundingClientRect(); if (r.bottom < -50 || r.top > window.innerHeight + 50) return false; return !(i.complete && i.naturalWidth > 0); }).map(i => i.getAttribute("src")).join(",")')) === '');

  /* the preview only exists for pointer devices, so ask for one */
  await rpc(ws, st, 'Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }] });
  await ev('(() => { const it = document.querySelector(".menu-item"); const r = it.getBoundingClientRect(); it.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 })); return true; })(); new Promise(r=>setTimeout(r,120))');
  check('hovering a service opens the preview card', (await ev('document.getElementById("peek").classList.contains("on")')) === true);
  check('the preview carries that service picture', (await ev('!!document.getElementById("peekImg").getAttribute("src")')) === true);
  check('the preview names the service', (await ev('document.getElementById("peekLabel").textContent.length')) > 2);
  await ev('document.querySelector(".menu-item").dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 700, clientY: 300 })); new Promise(r=>setTimeout(r,260))');
  var moved = await ev('document.getElementById("peek").style.transform');
  check('the card follows the cursor', /translate3d\(\d/.test(moved), moved);
  await ev('document.getElementById("serviceList").dispatchEvent(new MouseEvent("mouseleave", { bubbles: false })); new Promise(r=>setTimeout(r,80))');
  check('it closes again on leave', (await ev('document.getElementById("peek").classList.contains("on")')) === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  ws.close();
  process.exit(fail ? 1 : 0);
}()).catch(function (e) { console.error('CRASHED ' + e.message); process.exit(2); });
