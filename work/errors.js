/* Print any page errors and a few element counts, to find a broken render fast.
   Usage: node work/errors.js <port> */
var PORT = process.argv[2] || '9222';
var BASE = process.argv[3] || 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/index.html';

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

(async function () {
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws failed')); }; });
  var st = { id: 1 };
  var errors = [];
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      var d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description || d.text || '').split('\n').slice(0, 6).join('\n     '));
    }
  });
  await rpc(ws, st, 'Runtime.enable');
  /* file:// resources are cacheable, and testing a stale script is worse than no test */
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  var loaded = new Promise(function (res) {
    ws.addEventListener('message', function h(ev) {
      if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); }
    });
  });
  await rpc(ws, st, 'Page.navigate', { url: BASE });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,900))', awaitPromise: true });

  console.log('PAGE ERRORS: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
  var counts = await rpc(ws, st, 'Runtime.evaluate', {
    expression: 'JSON.stringify({menu:document.querySelectorAll(".menu-item").length,filters:document.querySelectorAll(".filter").length,reviews:document.querySelectorAll(".quote").length,foot:document.querySelectorAll(".foot > div").length,clipRows:document.querySelectorAll(".clip-row").length,nextFree:!!document.getElementById("nextFreeBtn"),nextFreeText:(document.getElementById("nextFreeText")||{}).textContent})',
    returnByValue: true
  });
  console.log('COUNTS: ' + counts.result.value);
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
