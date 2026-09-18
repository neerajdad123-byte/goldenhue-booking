/* Pull openly licensed photography from Openverse and store it next to the demo so
   the page has no third-party dependency at view time. Only CC0 and public-domain
   marks are accepted, so nothing here carries an attribution obligation.
   Usage: node work/fetch-images.js */
var fs = require('fs');
var path = require('path');

var OUT = path.join(__dirname, '..', 'outputs', 'demo', 'img');
var MIN_W = 1100;

/* slot name -> what the picture has to show. The demo needs spaces and craft
   close-ups, not identifiable faces passed off as fictional staff. */
/* Openverse matches loosely, and a search for a hair salon will happily return an
   18th century oil painting. Every candidate title has to contain one of these
   words before the picture is allowed into the demo. */
var WANTED = [
  { slot: 'cover-blushbloom', qs: ['manicure', 'nail salon', 'beauty salon'], ok: ['nail', 'manicure', 'beauty', 'salon', 'spa'] },
  { slot: 'craft-3', qs: ['hair dye', 'hair colouring', 'hair salon'], ok: ['hair', 'dye', 'colour', 'color', 'salon'] },
  { slot: 'craft-4', qs: ['manicure', 'nail polish', 'nails'], ok: ['nail', 'manicure', 'polish'] },
  { slot: 'craft-6', qs: ['hair washing', 'shampoo salon', 'hairdressing'], ok: ['hair', 'shampoo', 'salon', 'hairdress'] }
];

async function search(q, ok) {
  var url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) +
    '&license=cc0,pdm&page_size=20&mature=false';
  var res = await fetch(url, { headers: { 'User-Agent': 'GoldenhueDemo/1.0 (design mockup)' } });
  if (!res.ok) { throw new Error('openverse ' + res.status + ' for ' + q); }
  var json = await res.json();
  return (json.results || []).filter(function (r) {
    if (!r.url || r.width < MIN_W || r.height < 700) { return false; }
    var title = String(r.title || '').toLowerCase();
    return ok.some(function (word) { return title.indexOf(word) >= 0; });
  });
}

async function download(url, file) {
  var res = await fetch(url, { headers: { 'User-Agent': 'GoldenhueDemo/1.0 (design mockup)' } });
  if (!res.ok) { throw new Error('download ' + res.status); }
  var buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20000) { throw new Error('suspiciously small: ' + buf.length); }
  /* Trust the bytes, not the URL: Openverse serves WebP and PNG behind .jpg links,
     and a mislabelled extension breaks every decoder downstream. */
  var target = file.replace(/\.(jpe?g|png|webp)$/i, '') + '.' + sniff(buf);
  fs.writeFileSync(target, buf);
  return { bytes: buf.length, file: target };
}

function sniff(buf) {
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { return 'webp'; }
  if (buf[0] === 0xff && buf[1] === 0xd8) { return 'jpg'; }
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') { return 'png'; }
  return 'jpg';
}

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var credits = [];
  var failed = [];

  for (var w of WANTED) {
    var hit = null;
    for (var q of w.qs) {
      try {
        var hits = await search(q, w.ok);
        if (hits.length) { hit = hits[Math.min(w.pick || 0, hits.length - 1)]; break; }
      } catch (e) { /* try the next phrasing */ }
    }
    if (!hit) { failed.push(w.slot + ' (nothing relevant)'); continue; }
    try {
      var file = path.join(OUT, w.slot + '.img');
      var got = await download(hit.url, file);
      var size = got.bytes;
      credits.push({
        slot: w.slot, file: path.basename(got.file), query: hit.title,
        title: hit.title, creator: hit.creator || 'unknown',
        license: (hit.license || '').toUpperCase() + ' ' + (hit.license_version || ''),
        source: hit.foreign_landing_url || hit.url, bytes: size
      });
      console.log('ok   ' + w.slot + '  ' + Math.round(size / 1024) + 'kb  [' + hit.license + ']  ' + (hit.title || '').slice(0, 46));
    } catch (e) {
      failed.push(w.slot + ' (' + e.message + ')');
    }
  }

  fs.writeFileSync(path.join(OUT, 'CREDITS.json'), JSON.stringify({ note: 'Placeholder photography for the Goldenhue demo. Replace with the salon own photos before launch.', images: credits }, null, 2));
  console.log('\n' + credits.length + ' stored, ' + failed.length + ' failed');
  if (failed.length) { console.log('failed: ' + failed.join(', ')); }
  process.exit(credits.length ? 0 : 1);
}()).catch(function (e) { console.error('FATAL ' + e.message); process.exit(2); });
