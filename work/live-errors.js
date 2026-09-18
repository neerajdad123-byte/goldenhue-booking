/* Reload the served page with cache off and print every exception it throws. */
var PORT = process.argv[2] || '9222';
var URL_ = process.argv[3] || 'http://localhost:3000/';
function rpc(ws, st, method, params) {
  const id = ++st.id;
  return new Promise(function (resolve, reject) {
    function onMsg(ev) {
      var m = JSON.parse(ev.data);
      if (m.id !== id) { return; }
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method)) : resolve(m.result);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
(async function () {
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return /localhost:3000/.test(t.url || ''); })[0] ||
             list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  var seen = [];
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      var d = m.params.exceptionDetails;
      seen.push(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 4).join('\n     '));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      seen.push('console.error: ' + m.params.args.map(function (a) { return a.value || a.description || ''; }).join(' '));
    }
  });
  await rpc(ws, st, 'Runtime.enable');
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  var loaded = new Promise(function (res) {
    ws.addEventListener('message', function h(ev) {
      if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); }
    });
  });
  await rpc(ws, st, 'Page.navigate', { url: URL_ });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,1600))', awaitPromise: true });

  console.log('ERRORS: ' + (seen.length ? '\n  ' + seen.join('\n  ') : 'none'));
  var probe = await rpc(ws, st, 'Runtime.evaluate', {
    expression: 'JSON.stringify({badge:document.getElementById("liveBadge").textContent, menu:document.querySelectorAll(".menu-item").length, live:(typeof API!=="undefined"?API.live:"no API")})',
    returnByValue: true
  });
  console.log('STATE: ' + probe.result.value);
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(2); });
