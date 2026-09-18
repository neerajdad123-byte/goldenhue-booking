/* Writes the screens a person would actually look at into outputs/demo-shots/.
   Usage: node work/shots.js <cdp-port> */
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
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws failed')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  /* file:// resources are cacheable, and testing a stale script is worse than no test */
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });

  async function shot(name, width, height, setup) {
    await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false });
    var loaded = once(ws, 'Page.loadEventFired');
    await rpc(ws, st, 'Page.navigate', { url: setup.url });
    await loaded;
    await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,1400)))', awaitPromise: true });
    if (setup.script) {
      await rpc(ws, st, 'Runtime.evaluate', { expression: setup.script, awaitPromise: true });
      await rpc(ws, st, 'Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,900))', awaitPromise: true });
    }
    var res = await rpc(ws, st, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.data, 'base64'));
    console.log(name + ' ' + Math.round(Buffer.from(res.data, 'base64').length / 1024) + 'kb');
  }

  await shot('1-services.png', 1440, 1120, { url: BASE });
  await shot('2-peek.png', 1440, 1120, {
    url: BASE,
    script: '(() => { const it = document.querySelectorAll(".menu-item")[1]; const r = it.getBoundingClientRect(); it.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); window.dispatchEvent(new MouseEvent("mousemove")); const ev = new MouseEvent("mousemove", { bubbles: true, clientX: r.right - 180, clientY: r.top + 60 }); document.getElementById("serviceList").dispatchEvent(ev); })(); new Promise(r=>setTimeout(r,700))'
  });
  await shot('3-diary.png', 1440, 980, { url: BASE + '?service=gh-colour&staff=any&day=1&step=3' });
  await shot('4-chosen.png', 1440, 980, {
    url: BASE + '?service=gh-colour&staff=any&day=1&step=3',
    script: 'document.querySelector(".blk-free").click(); new Promise(r=>setTimeout(r,700))'
  });
  await shot('5-confirmed.png', 1440, 1100, {
    url: BASE,
    script: '(async () => { document.querySelector(".menu-item").click(); await new Promise(r=>setTimeout(r,400)); document.querySelector(".crew-item").click(); await new Promise(r=>setTimeout(r,700)); document.querySelector(".blk-free").click(); await new Promise(r=>setTimeout(r,700)); document.querySelector("[data-action=continue]").click(); await new Promise(r=>setTimeout(r,300)); document.getElementById("fName").value="Kavya Sharma"; document.getElementById("fPhone").value="9876543210"; document.getElementById("detailsForm").requestSubmit(); await new Promise(r=>setTimeout(r,900)); })()'
  });
  await shot('6-mobile.png', 430, 1100, { url: BASE });

  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
