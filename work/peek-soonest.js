/* What does the page look like right after the soonest-chair button?
   Usage: node work/peek-soonest.js <port> */
var PORT = process.argv[2] || '9225';
var BASE = 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/index.html';
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
  const loaded = onceOrTimeout(ws, 'Page.loadEventFired', 12000);
  await rpc(ws, st, 'Page.navigate', { url: BASE });
  await loaded;
  await rpc(ws, st, 'Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,900)))', awaitPromise: true });

  const expr = `(async () => {
    const out = {};
    document.querySelector('.menu-item').click();
    await new Promise(r => setTimeout(r, 800));
    out.beforeClick = document.getElementById('nextFreeText').textContent;
    document.getElementById('nextFreeBtn').click();
    await new Promise(r => setTimeout(r, 1400));
    out.step3Visible = !document.getElementById('panel-3').hidden;
    out.uiDate = window.__gh.ui.dateISO;
    out.startISO = window.__gh.ui.startISO;
    out.pickStaffIds = window.__gh.ui.pickStaffIds;
    out.pressedBars = document.querySelectorAll('.blk-free[aria-pressed="true"]').length;
    out.totalBars = document.querySelectorAll('.blk-free').length;
    out.firstBar = (document.querySelector('.blk-free') || {}).dataset ? document.querySelector('.blk-free').dataset.start : null;
    out.barsSnippet = Array.from(document.querySelectorAll('.blk-free')).slice(0, 3).map(b => b.dataset.staff + '@' + b.dataset.start + ' pressed=' + b.getAttribute('aria-pressed'));
    out.tagWhen = document.querySelector('[data-k="when"] .v').textContent;
    return JSON.stringify(out, null, 1);
  })()`;
  const r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(r.result.value || JSON.stringify(r));
  ws.close();
  process.exit(0);
})().catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
