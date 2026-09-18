/* Ask the live page, in its own words, what it thinks is going on. */
var PORT = process.argv[2] || '9222';
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
  var pattern = process.env.GH_URL_PATTERN || 'localhost:3000';
  var page = list.filter(function (t) { return new RegExp(pattern).test(t.url || ''); })[0];
  if (!page) { console.log('no live tab open'); process.exit(1); }
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Runtime.enable');
  var expr = `(async () => {
    const out = {};
    out.url = location.href;
    out.ghHandle = typeof window.__gh;
    if (window.__gh) {
      out.live = window.__gh.api.live;
      out.streamState = window.__gh.api.stream ? window.__gh.api.stream.readyState : null;
      out.step = window.__gh.ui.step;
      out.salon = window.__gh.ui.salonId;
      out.appointments = window.__gh.state.appointments.length;
      out.bootLog = window.__gh.bootLog;
    }
    out.streamProbe = await new Promise(res => {
      let got = false;
      const es = new EventSource('api/stream?salon=goldenhue');
      es.onmessage = () => { got = true; es.close(); res('message received'); };
      es.onerror = () => { es.close(); res(got ? 'message then error' : 'error, readyState ' + es.readyState); };
      setTimeout(() => { es.close(); res(got ? 'message received' : 'no message in 1.5s'); }, 1500);
    });
    try {
      const r = await fetch('api/catalog');
      out.status = r.status;
      const j = await r.json();
      out.keys = Object.keys(j);
      out.salonCount = (j.salons || []).length;
    } catch (e) { out.fetchError = String(e); }
    out.badge = document.getElementById('liveBadge').textContent;
    out.demoNote = (document.getElementById('demoNote') || {}).textContent;
    return JSON.stringify(out, null, 1);
  })()`;
  var r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(r.result.value || JSON.stringify(r));
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(2); });
