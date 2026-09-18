/* No browser here, so this catches the two mistakes that break a demo:
   an id the script expects but the markup does not have, and an icon key
   with no matching sprite symbol. */
var fs = require('fs');
var path = require('path');

var dir = path.join(__dirname, '..', 'outputs', 'demo');
var html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
var app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
var data = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');

var htmlIds = {};
(html.match(/ id="[^"]+"/g) || []).forEach(function (m) { htmlIds[m.slice(5, -1)] = 1; });
/* renderers build some ids in their own templates, so count those too */
(app.match(/ id="[^"]+"/g) || []).forEach(function (m) { htmlIds[m.slice(5, -1)] = 1; });

var wanted = {};
(app.match(/el\('[^']+'\)/g) || []).forEach(function (m) { wanted[m.slice(4, -2)] = 1; });

var panelIds = {};
for (var i = 1; i <= 5; i += 1) { panelIds['panel-' + i] = 1; }

var missing = Object.keys(wanted).filter(function (id) { return !htmlIds[id] && !panelIds[id]; });
var unused = Object.keys(htmlIds).filter(function (id) { return !wanted[id] && id.indexOf('i-') !== 0; });

var symbols = {}, used = {};
(html.match(/symbol id="[^"]+"/g) || []).forEach(function (m) { symbols[m.slice(11, -1)] = 1; });
((html + app).match(/href="#i-[a-z-]+"/g) || []).forEach(function (m) { used[m.slice(7, -1)] = 1; });
var badIcons = Object.keys(used).filter(function (k) { return !symbols[k]; });
var orphanSymbols = Object.keys(symbols).filter(function (k) { return !used[k]; });

console.log('ids the script wants:      ' + Object.keys(wanted).length);
console.log('ids in the markup:         ' + Object.keys(htmlIds).length);
console.log('missing from markup:       ' + (missing.length ? missing.join(', ') : 'none'));
console.log('markup ids never used:     ' + (unused.length ? unused.join(', ') : 'none'));
console.log('icons used / defined:      ' + Object.keys(used).length + ' / ' + Object.keys(symbols).length);
console.log('icons with no symbol:      ' + (badIcons.length ? badIcons.join(', ') : 'none'));
console.log('symbols never referenced:  ' + (orphanSymbols.length ? orphanSymbols.join(', ') : 'none'));

// Every data-* attribute the click handlers read must be written by a renderer.
['data-id', 'data-date', 'data-start', 'data-staff', 'data-action'].forEach(function (attr) {
  var written = app.indexOf(attr + '="') >= 0 || html.indexOf(attr + '="') >= 0;
  var read = app.indexOf(attr.slice(5)) >= 0;
  if (read && !written) { console.log('WARN: handler reads ' + attr + ' but nothing writes it'); }
});

var problems = missing.length + badIcons.length;
console.log(problems ? problems + ' WIRING PROBLEMS' : 'wiring clean');
process.exit(problems ? 1 : 0);
