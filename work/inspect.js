/* Renders the demo in headless Chrome over the DevTools protocol and reports what a
   screenshot would show a human: overflow, clipped text, bars escaping their lane,
   real contrast ratios, whether the fonts arrived, and whether the sticky lane
   labels hold while the rail scrolls. Usage: node work/inspect.js <cdp-port> */
var PORT = process.argv[2] || '9222';
var BASE = 'file:///C:/Users/neera/Documents/Codex/2026-09-18/se/outputs/demo/index.html';

var VIEWPORTS = [
  { name: 'desktop-menu', width: 1440, height: 950, url: BASE },
  { name: 'desktop-crew', width: 1440, height: 950, url: BASE + '?service=gh-colour&staff=any&day=1&step=2' },
  { name: 'mobile-crew', width: 430, height: 900, url: BASE + '?service=gh-colour&staff=any&day=1&step=2' },
  { name: 'desktop-rail', width: 1440, height: 950, url: BASE + '?service=gh-colour&staff=any&day=1&step=3' },
  { name: 'laptop-rail', width: 1200, height: 850, url: BASE + '?service=gh-colour&staff=any&day=1&step=3' },
  { name: 'tablet-rail', width: 900, height: 900, url: BASE + '?service=gh-haircut&staff=any&day=1&step=3' },
  { name: 'mobile-rail', width: 430, height: 900, url: BASE + '?service=gh-haircut&staff=any&day=1&step=3' }
];

var PROBE = `(async () => {
  await document.fonts.ready;
  await new Promise(r => setTimeout(r, 700));
  const out = {};
  const de = document.documentElement;
  out.horizontalOverflow = de.scrollWidth - window.innerWidth;
  out.viewport = [window.innerWidth, window.innerHeight];
  out.fonts = { anton: document.fonts.check('16px "Anton"'), grotesk: document.fonts.check('16px "Space Grotesk"') };
  out.headline = document.querySelector('.headline')?.textContent || null;

  const q = (s) => Array.from(document.querySelectorAll(s));
  out.counts = {
    menu: q('.menu-item').length, crew: q('.crew-item').length, days: q('.day').length,
    railRows: q('.rail-row').length, lit: q('.blk-free').length, taken: q('.blk-taken').length,
    short: q('.blk-short').length, chips: q('.slot').length, nowline: q('.nowline').length
  };

  /* Chrome serialises some colours as oklab()/color(), so paint the value onto a
     1x1 canvas and read the pixel back. That is the only reliable normaliser. */
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const toRgb = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const lum = (c) => {
    const p = toRgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
  const rgbOf = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const bg = getComputedStyle(document.body).backgroundColor;
  const brand = getComputedStyle(de).getPropertyValue('--brand').trim();
  const bar = document.querySelector('.blk-free') || document.querySelector('.day[aria-pressed="true"]');
  out.contrast = {
    bodyTextOnWhite: ratio(getComputedStyle(document.querySelector('.sub') || document.body).color, bg),
    eyebrowOnWhite: ratio(getComputedStyle(document.querySelector('.kicker')).color, bg),
    quietTextOnWhite: ratio(getComputedStyle(document.querySelector('.clip-row .k')).color, bg),
    inkOnBrandFill: bar ? ratio(getComputedStyle(bar).color, getComputedStyle(bar).backgroundColor) : 'no brand surface yet'
  };
  /* every salon must clear 4.5:1 for its text colour on white, and for the ink
     that sits on its fill */
  out.brandMatrix = (window.DATA ? DATA.salons : []).map(s => ({
    salon: s.id,
    deepTextOnWhite: ratio(rgbOf(s.brand.deep), '#fff'),
    inkOnFill: ratio(rgbOf(s.brand.ink), rgbOf(s.brand.light))
  }));

  /* Only a real clip if something actually hides the overflow. Tight display
     leading happily paints outside its box, and that is intended. */
  const hides = (el) => {
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
      const o = getComputedStyle(n);
      if (o.overflow !== 'visible' || o.overflowX !== 'visible' || o.overflowY !== 'visible') return n.className || n.tagName;
    }
    return false;
  };
  out.clipped = q('.headline, .menu-name, .menu-desc, .crew-name, .crew-bio, .blk-time, .blk-len, .lane-name b, .clip-row .v, .clip-service, .stub-title, .btn, .bar-top')
    .filter(el => el.offsetParent !== null)
    .filter(el => el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
    .filter(hides)
    .slice(0, 6)
    .map(el => el.className + ' :: "' + el.textContent.trim().slice(0, 24) + '" ' + el.scrollWidth + 'x' + el.scrollHeight + ' in ' + el.clientWidth + 'x' + el.clientHeight + ' clipped by ' + hides(el));

  /* the sliding pill must be sitting on the selected day */
  const pill = document.getElementById('dayFloat');
  const active = document.querySelector('.day[aria-pressed="true"]');
  /* the pill is moved with a transform, so compare painted rectangles, not offsets */
  out.dayPill = (pill && active)
    ? (() => {
        const p = pill.getBoundingClientRect(), a = active.getBoundingClientRect();
        return { aligned: Math.abs(p.left - a.left) < 2 && Math.abs(p.width - a.width) < 2, pillW: Math.round(p.width), dayW: Math.round(a.width) };
      })()
    : 'no pill';

  out.escaped = [];
  q('.lane-track').forEach((track, i) => {
    const tr = track.getBoundingClientRect();
    q('.blk').filter(b => b.parentElement === track).forEach(b => {
      const br = b.getBoundingClientRect();
      if (br.right > tr.right + 1 || br.left < tr.left - 1 || br.bottom > tr.bottom + 1) {
        out.escaped.push('lane ' + i + ' ' + b.className + ' left ' + Math.round(br.left - tr.left) + ' right ' + Math.round(br.right - tr.left) + ' trackW ' + Math.round(tr.width));
      }
    });
  });

  const scroller = document.querySelector('.rail-scroll');
  if (scroller && scroller.offsetParent) {
    out.rail = { clientW: scroller.clientWidth, scrollW: scroller.scrollWidth, scrollable: scroller.scrollWidth > scroller.clientWidth + 4 };
    const label = document.querySelector('.lane-name');
    if (label) {
      const before = label.getBoundingClientRect().left;
      scroller.scrollLeft = 300;
      await new Promise(r => requestAnimationFrame(r));
      const after = label.getBoundingClientRect().left;
      out.rail.stickyHeld = Math.abs(after - before) < 3;
      out.rail.drift = Math.round(after - before);
      scroller.scrollLeft = 0;
    }
  }

  out.columns = ['.sign', '.stage', '.clip'].map(s => {
    const el = document.querySelector(s);
    if (!el || !el.offsetParent) return s + ':hidden';
    const r = el.getBoundingClientRect();
    return s + ':' + Math.round(r.width) + 'x' + Math.round(r.height);
  });
  out.barVisible = !document.querySelector('.bar').hidden;
  out.docHeight = de.scrollHeight;
  /* every picture on the page has to have decoded, or the design is lying */
  /* Only pictures that are meant to be on screen right now. An image with no src
     yet, or one that is lazy and still below the fold, is not a broken image. */
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > -50 && r.top < window.innerHeight + 50 && r.width > 0; };
  out.images = q('img').filter(i => i.getAttribute('src') && i.offsetParent !== null && (i.loading !== 'lazy' || inView(i)))
    .map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth, ok: i.complete && i.naturalWidth > 0 }));
  out.imagesBroken = out.images.filter(i => !i.ok).map(i => i.src);
  out.cover = (() => {
    const c = document.getElementById('cover');
    if (!c) return 'absent';
    const img = document.getElementById('coverImg');
    return { ready: c.classList.contains('ready'), loaded: img.complete && img.naturalWidth > 0, cssW: Math.round(c.getBoundingClientRect().width), cssH: Math.round(c.getBoundingClientRect().height) };
  })();
  out.gallery = { shots: q('.shot').length, runW: Math.round(document.getElementById('galleryRun').getBoundingClientRect().width) };
  out.headlineWords = q('.headline .w').length;
  return JSON.stringify(out, null, 1);
})()`;

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
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  if (!page) { throw new Error('no page target'); }
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws failed')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  /* file:// resources are cacheable, and testing a stale script is worse than no test */
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });
  for (var v of VIEWPORTS) {
    await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: false });
    var loaded = once(ws, 'Page.loadEventFired');
    await rpc(ws, st, 'Page.navigate', { url: v.url });
    await loaded;
    var res = await rpc(ws, st, 'Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
    console.log('=== ' + v.name + ' (' + v.width + 'x' + v.height + ')');
    if (res.exceptionDetails) {
      console.log('PROBE THREW: ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
    } else {
      console.log(res.result.value);
    }
  }
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
