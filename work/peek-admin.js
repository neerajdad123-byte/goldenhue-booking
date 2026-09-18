/* Report what the front desk actually rendered, so an empty page cannot pass.
   Usage: node work/peek-admin.js <port> [base] */
var PORT = process.argv[2] || '9225';
var BASE = process.argv[3] || 'http://localhost:3000/admin';
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
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.filter(function (t) { return t.type === 'page'; })[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = function () { j(new Error('ws')); }; });
  const st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false });
  const loaded = onceOrTimeout(ws, 'Page.loadEventFired', 12000);
  await rpc(ws, st, 'Page.navigate', { url: BASE });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,1200)))', awaitPromise: true });
  const expr = `JSON.stringify({
    stats: [...document.querySelectorAll('.stat')].map(e => e.querySelector('.v').textContent),
    lanes: document.querySelectorAll('.lane').length,
    appts: document.querySelectorAll('.appt').length,
    services: document.querySelectorAll('#svcRows tr').length,
    people: document.querySelectorAll('.person').length,
    dayRows: document.querySelectorAll('.dayrow').length,
    title: document.getElementById('dayTitle').textContent,
    sub: document.getElementById('daySub').textContent,
    docHeight: document.documentElement.scrollHeight,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    firstLaneText: (document.querySelector('.lane-top') || {}).textContent || null
  }, null, 1)`;
  const r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close();
  process.exit(0);
})().catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
