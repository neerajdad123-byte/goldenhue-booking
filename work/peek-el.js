/* Print the computed colour and background of specific selectors, so a contrast
   report can be checked instead of assumed. Usage: node work/peek-el.js <port> <url> <sel,sel> */
var PORT = process.argv[2] || '9222';
var URL_ = process.argv[3];
var SELS = (process.argv[4] || '.demo-badge,.mini-btn,.next-free,.crumb').split(',');

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
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  var loaded = new Promise(function (res) {
    ws.addEventListener('message', function h(ev) {
      if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); }
    });
  });
  await rpc(ws, st, 'Page.navigate', { url: URL_ });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,600)))', awaitPromise: true });
  var expr = 'JSON.stringify(' + JSON.stringify(SELS) + '.map(s => { const el = document.querySelector(s); if (!el) return {s, missing:true}; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { s, color: cs.color, bg: cs.backgroundColor, backgroundImage: cs.backgroundImage.slice(0,40), h: Math.round(r.height), w: Math.round(r.width), padding: cs.padding, fontSize: cs.fontSize }; }), null, 1)';
  var r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
