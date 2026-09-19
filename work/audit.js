/* A design audit of a rendered page: measures the things that actually look wrong
   on screen, at every width that matters. Reports findings, changes nothing.
   Usage: node work/audit.js <cdp-port> [url] */
var PORT = process.argv[2] || '9222';
var URL_ = process.argv[3] || 'https://neerajdad123-byte.github.io/goldenhue-booking/';

var WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
var PATHS = [
  { name: 'services', q: '' },
  { name: 'crew', q: '?service=gh-colour&staff=any&step=2' },
  { name: 'diary', q: '?service=gh-colour&staff=any&day=1&step=3' },
  { name: 'frontdesk', q: 'admin', append: true }
];

var PROBE = `(async () => {
  await document.fonts.ready;
  /* Measure the settled page, not one mid-animation. A word rising out of its mask
     is momentarily offset by most of its own height, which read as "the mask is
     cutting the text" and produced findings that came and went between runs. */
  const settle = async () => {
    const running = document.getAnimations().filter(a => {
      const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      return timing.iterations !== Infinity;   /* the marquee never finishes, by design */
    });
    if (!running.length) { return; }
    await Promise.race([
      Promise.all(running.map(a => a.finished.catch(() => {}))),
      new Promise(r => setTimeout(r, 4000))
    ]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  await settle();
  await new Promise(r => setTimeout(r, 250));
  const de = document.documentElement;
  const W = window.innerWidth, H = window.innerHeight;
  const out = { w: W, findings: [] };

  const vis = (el) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const rect = (el) => el.getBoundingClientRect();

  /* 1. horizontal overflow, and which element causes it */
  const over = de.scrollWidth - W;
  if (over > 1) {
    const culprits = [...document.querySelectorAll('body *')]
      .filter(vis)
      .filter(el => rect(el).right > W + 1 || rect(el).left < -1)
      .filter(el => !el.closest('.rail-scroll, .datestrip, .dayrail, .reviews-track, .gallery, .gallery-run'))
      .slice(0, 5)
      .map(el => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] + ' right=' + Math.round(rect(el).right));
    out.findings.push('HORIZONTAL OVERFLOW ' + over + 'px :: ' + (culprits.join(' | ') || 'no single culprit found'));
  }

  /* 2. effective background, for honest contrast maths */
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      if (p && p.a > 0.95) return c;
      if (!p && c && c !== 'transparent') return c;
    }
    return 'rgb(255,255,255)';
  };
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  /* Read rgb()/rgba() directly. An earlier version pushed every colour through a
     canvas, which quietly kept black for the values it could not parse and so
     reported perfect contrast as 1:1. Parse first, canvas only as a last resort. */
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const rgb = (c) => {
    const p = parse(c);
    if (p) return [p.r, p.g, p.b];
    ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const lum = (c) => { const p = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };

  /* 3. text that fails contrast, ignoring decorative caps and huge display type */
  const textFail = [];
  [...document.querySelectorAll('p, span, li, dd, dt, a, button, label, h1, h2, h3, strong, em')]
    .filter(vis)
    .filter(el => el.textContent.trim().length > 1 && el.children.length === 0)
    .forEach(el => {
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const got = ratio(s.color, bgOf(el));
      if (got < need) {
        textFail.push(el.className.toString().split(' ')[0] + '=' + got + '(need ' + need + ') "' + el.textContent.trim().slice(0, 20) + '"');
      }
    });
  if (textFail.length) out.findings.push('LOW CONTRAST :: ' + [...new Set(textFail)].slice(0, 6).join(' | '));

  /* 4. tap targets too small for a thumb */
  if (W <= 480) {
    const small = [...document.querySelectorAll('button, a[href], select, input, textarea')]
      .filter(vis)
      .map(el => ({ el, r: rect(el) }))
      .filter(x => x.r.height < 44 || x.r.width < 30)
      .slice(0, 6)
      .map(x => (x.el.className || x.el.tagName).toString().split(' ')[0] + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height));
    if (small.length) out.findings.push('SMALL TAP TARGETS :: ' + small.join(' | '));
  }

  /* 5. fixed furniture covering content */
  const bar = document.querySelector('.bar');
  if (bar && !bar.hidden && getComputedStyle(bar).display !== 'none') {
    const br = rect(bar);
    const covered = [...document.querySelectorAll('.foot > *, .stub-actions, .form, .slot-area')]
      .filter(vis)
      .filter(el => rect(el).bottom > br.top + 2 && rect(el).top < br.bottom)
      .map(el => (el.className || el.tagName).toString().split(' ')[0]);
    if (covered.length) out.findings.push('ACTION BAR COVERS :: ' + covered.join(', ') + ' (bar top ' + Math.round(br.top) + ')');
    out.barHeight = Math.round(br.height);
  }

  /* 6. text clipped by an ancestor that hides overflow */
  const hides = (el) => {
    for (let n = el, i = 0; n && i < 5; n = n.parentElement, i++) {
      const o = getComputedStyle(n);
      if (o.overflow !== 'visible' || o.overflowY !== 'visible') return true;
    }
    return false;
  };
  const clipped = [...document.querySelectorAll('.headline, .menu-name, .menu-desc, .crew-name, .crew-bio, .crew-next, .clip-service, .clip-row .v, .stub-title, .btn, .bar-top, .bar-sub, .blk-time, .lane-name b, .quote p, .foot-brand, .live-badge, .demo-note')]
    .filter(vis)
    .filter(el => el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
    .filter(hides)
    .slice(0, 6)
    .map(el => el.className.toString().split(' ')[0] + ' "' + el.textContent.trim().slice(0, 18) + '" ' + el.scrollWidth + 'x' + el.scrollHeight + ' in ' + el.clientWidth + 'x' + el.clientHeight);
  if (clipped.length) out.findings.push('CLIPPED TEXT :: ' + clipped.join(' | '));

  /* 6b. the headline masks clip by design. Make sure they clip the line box and
     not the letters: a serif with descenders will lose its g and y if the mask is
     only as tall as the cap height. */
  const masks = [...document.querySelectorAll('.headline .w')];
  const cut = masks.filter(m => {
    const inner = m.querySelector('i');
    if (!inner) return false;
    const mi = inner.getBoundingClientRect(), mm = m.getBoundingClientRect();
    return mi.height > mm.height + 1.5 || mi.bottom > mm.bottom + 1.5 || mi.top < mm.top - 1.5;
  });
  if (cut.length) {
    const m = cut[0], i = m.querySelector('i');
    out.findings.push('HEADLINE MASK CUTS TEXT :: ' + cut.length + ' of ' + masks.length +
      ' words, e.g. "' + m.textContent + '" inner ' + Math.round(i.getBoundingClientRect().height) +
      'px in mask ' + Math.round(m.getBoundingClientRect().height) + 'px');
  }

  /* 7. the moving bands: do they actually fill the space they scroll through? */
  const track = document.querySelector('.reviews-track');
  if (track && vis(track)) {
    const runs = [...track.querySelectorAll('.reviews-run')];
    const total = runs.reduce((n, r) => n + rect(r).width, 0);
    out.marquee = { track: Math.round(rect(track).width), runs: runs.length, total: Math.round(total), covers: total >= rect(track).width * 2 };
    if (runs.length && runs[0].offsetWidth * 2 < rect(track).width) {
      out.findings.push('MARQUEE SHOWS A GAP :: run ' + Math.round(runs[0].offsetWidth) + 'px, twice is ' + Math.round(runs[0].offsetWidth * 2) + 'px, track is ' + Math.round(rect(track).width) + 'px');
    }
  }
  const gal = document.querySelector('.gallery-run');
  if (gal && vis(gal)) {
    const half = rect(gal).width / 2;
    if (half < rect(gal.parentElement).width) {
      out.findings.push('WORK BAND SHOWS A GAP :: half is ' + Math.round(half) + 'px, band is ' + Math.round(rect(gal.parentElement).width) + 'px');
    }
  }

  /* 8. images and fonts */
  const broken = [...document.querySelectorAll('img')].filter(i => vis(i) && i.getAttribute('src') && !(i.complete && i.naturalWidth > 0));
  if (broken.length) out.findings.push('BROKEN IMAGES :: ' + broken.map(i => i.getAttribute('src')).join(', '));
  if (!document.fonts.check('16px "Anton"')) out.findings.push('DISPLAY FONT DID NOT LOAD');
  if (!document.fonts.check('16px "Space Grotesk"')) out.findings.push('BODY FONT DID NOT LOAD');

  /* 9. anything meant to hold content that came out empty */
  const empty = ['.menu-item', '.crew-item', '.day', '.blk-free', '.clip-row', '.foot > div']
    .map(sel => ({ sel, n: [...document.querySelectorAll(sel)].filter(vis).length, textLen: [...document.querySelectorAll(sel)].filter(vis).reduce((a, e) => a + e.textContent.trim().length, 0) }))
    .filter(x => x.n > 0 && x.textLen === 0)
    .map(x => x.sel);
  if (empty.length) out.findings.push('VISIBLE BUT EMPTY :: ' + empty.join(', '));

  out.docHeight = de.scrollHeight;
  return JSON.stringify(out);
})()`;

function rpc(ws, st, method, params) {
  const id = ++st.id;
  return new Promise(function (resolve, reject) {
    function onMsg(ev) {
      var m = JSON.parse(ev.data);
      if (m.id !== id) { return; }
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function onceOrTimeout(ws, event, ms) {
  return new Promise(function (resolve) {
    function onMsg(ev) {
      var m = JSON.parse(ev.data);
      if (m.method !== event) { return; }
      ws.removeEventListener('message', onMsg);
      resolve(m.params);
    }
    ws.addEventListener('message', onMsg);
    setTimeout(resolve, ms);
  });
}

(async function () {
  var list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  if (!page) { throw new Error('no page target'); }
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = function () { rej(new Error('ws')); }; });
  var st = { id: 1 };
  await rpc(ws, st, 'Page.enable');
  await rpc(ws, st, 'Runtime.enable');
  await rpc(ws, st, 'Network.enable');
  await rpc(ws, st, 'Network.setCacheDisabled', { cacheDisabled: true });

  var total = 0;
  for (var p of PATHS) {
    for (var w of WIDTHS) {
      await rpc(ws, st, 'Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 480 });
      var loaded = onceOrTimeout(ws, 'Page.loadEventFired', 12000);
      await rpc(ws, st, 'Page.navigate', { url: p.append ? URL_.replace(/\/?$/, '/') + p.q : URL_ + p.q });
      await loaded;
      var res = await rpc(ws, st, 'Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        console.log(p.name + ' @' + w + ' :: PROBE THREW ' + (res.exceptionDetails.exception || {}).description);
        continue;
      }
      var r = JSON.parse(res.result.value);
      var tag = p.name.padEnd(9) + ' @' + String(w).padEnd(5);
      if (!r.findings.length) { console.log(tag + 'clean'); } else {
        total += r.findings.length;
        r.findings.forEach(function (f, i) { console.log((i ? '         ' : tag) + f); });
      }
    }
  }
  console.log('\n' + total + ' findings');
  ws.close();
  process.exit(0);
}()).catch(function (e) { console.error('FAILED ' + e.message); process.exit(1); });
