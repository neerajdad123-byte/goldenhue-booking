/* Capture the last two screens on their own, so a long run cannot lose them. */
var fs = require('fs');
var path = require('path');
var PORT = process.argv[2] || '9222';
var BASE = 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/index.html';
var OUT = path.join(__dirname, '..', 'outputs', 'demo-shots');

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

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');

  async function shot(name, width, height, url, script) {
    await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false });
    var loaded = once(ws, 'Page.loadEventFired');
    await rpc(ws, st, 'Page.navigate', { url: url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,1200)))', awaitPromise: true });
    if (script) {
      var res = await rpc(ws, st, 'Runtime.evaluate', { expression: script, awaitPromise: true });
      if (res.exceptionDetails) { console.log('  script error: ' + res.exceptionDetails.text); }
      await rpc(ws, st, 'Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,900))', awaitPromise: true });
    }
    var cap = await rpc(ws, st, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(cap.data, 'base64'));
    console.log(name + ' written');
  }

  await shot('2-crew.png', 1440, 1100, BASE + '?service=gh-colour&staff=any&day=1&step=2', null);
  await shot('5-confirmed.png', 1440, 1100, BASE,
    '(async () => { document.querySelector(".menu-item").click(); await new Promise(r=>setTimeout(r,500)); document.querySelector(".crew-item").click(); await new Promise(r=>setTimeout(r,900)); const b = document.querySelector(".blk-free"); if (!b) throw new Error("no free bar"); b.click(); await new Promise(r=>setTimeout(r,700)); document.querySelector("[data-action=continue]").click(); await new Promise(r=>setTimeout(r,400)); document.getElementById("fName").value="Kavya Sharma"; document.getElementById("fPhone").value="9876543210"; document.getElementById("detailsForm").requestSubmit(); await new Promise(r=>setTimeout(r,1000)); })()');
  await shot('6-mobile.png', 430, 1100, BASE, null);

  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
