/* Confirm which fonts actually rendered, and that the headline masks are real.
   Usage: node work/font-check.js <port> <url> */
var PORT = process.argv[2] || '9225';
var URL_ = process.argv[3] || 'http://localhost:3000/';
function rpc(ws, st, m, p) {
  const id = ++st.id;
  return new Promise(function (res, rej) {
    function on(ev) {
      const x = JSON.parse(ev.data);
      if (x.id !== id) return;
      ws.removeEventListener('message', on);
      x.error ? rej(new Error(m)) : res(x.result);
    }
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: id, method: m, params: p || {} }));
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
  const loaded = new Promise(function (r) {
    ws.addEventListener('message', function h(ev) {
      if (JSON.parse(ev.data).method === 'Page.loadEventFired') { ws.removeEventListener('message', h); r(); }
    });
  });
  await rpc(ws, st, 'Page.navigate', { url: URL_ });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,900)))', awaitPromise: true });
  const expr = `(() => {
    const masks = [...document.querySelectorAll('.headline .w')];
    const h = document.querySelector('.headline');
    const cs = h ? getComputedStyle(h) : null;
    const words = masks.map(m => {
      const i = m.querySelector('i');
      return { t: m.textContent, inner: Math.round(i.getBoundingClientRect().height), mask: Math.round(m.getBoundingClientRect().height) };
    });
    return JSON.stringify({
      fraunces: document.fonts.check('16px "Fraunces"'),
      jakarta: document.fonts.check('16px "Plus Jakarta Sans"'),
      oldAnton: document.fonts.check('16px "Anton"'),
      headlineFont: cs ? cs.fontFamily : null,
      headlineText: h ? h.textContent : null,
      headlineTransform: cs ? cs.textTransform : null,
      headlineLineHeight: cs ? cs.lineHeight : null,
      bodyFont: getComputedStyle(document.querySelector('.sub') || document.body).fontFamily,
      maskCount: masks.length,
      looseMasks: words.filter(w => w.inner > w.mask + 1.5).length,
      sample: words.slice(0, 4)
    }, null, 1);
  })()`;
  const r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close();
  process.exit(0);
})().catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
