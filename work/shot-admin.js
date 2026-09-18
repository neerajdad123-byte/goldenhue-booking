/* Capture the front desk. Usage: node work/shot-admin.js <port> [base] */
var fs = require('fs');
var path = require('path');
var PORT = process.argv[2] || '9225';
var BASE = process.argv[3] || 'http://localhost:3000/';
var OUT = path.join(__dirname, '..', 'outputs', 'demo-shots');

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
  fs.mkdirSync(OUT, { recursive: true });
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.filter(function (t) { return t.type === 'page'; })[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = function () { j(new Error('ws')); }; });
  const st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');

  async function shot(name, w, h, url) {
    await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const loaded = onceOrTimeout(ws, 'Page.loadEventFired', 12000);
    await rpc(ws, st, 'Page.navigate', { url: url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,1600)))', awaitPromise: true });
    /* the front desk is a long page, so capture all of it rather than the fold */
    const cap = await rpc(ws, st, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(cap.data, 'base64'));
    console.log(name + ' written');
  }

  await shot('7-frontdesk.png', 1440, 1500, BASE + 'admin');
  ws.close();
  process.exit(0);
})().catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
