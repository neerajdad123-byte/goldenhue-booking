/* Report natural size and aspect of every demo image, measured in a real browser
   so WebP and JPEG are both decoded by the same engine the page will use. */
var fs = require('fs');
var path = require('path');
var PORT = process.argv[2] || '9222';
var IMG = 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/img/';

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
  var dir = path.join(__dirname, '..', 'outputs', 'demo', 'img');
  var files = fs.readdirSync(dir).filter(function (f) { return /\.(jpe?g|png|webp)$/i.test(f); });
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws failed')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Runtime.enable');
  for (var f of files) {
    var expr = 'new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => res("FAILED"); i.src = ' +
      JSON.stringify(IMG + f) + '; })';
    var r = await rpc(ws, st, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    var dims = r.result.value;
    var ratio = dims === 'FAILED' ? '-' : (Number(dims.split('x')[0]) / Number(dims.split('x')[1])).toFixed(2);
    console.log(f.padEnd(24) + dims.padEnd(12) + ' ratio ' + ratio + '  ' + Math.round(fs.statSync(path.join(dir, f)).size / 1024) + 'kb');
  }
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
