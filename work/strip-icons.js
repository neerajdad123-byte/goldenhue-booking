var fs = require('fs');
var p = __dirname + '/../outputs/demo/data.js';
var s = fs.readFileSync(p, 'utf8');
var hits = (s.match(/ icon: '[^']+',/g) || []).length;
fs.writeFileSync(p, s.replace(/ icon: '[^']+',/g, ''));
console.log('removed ' + hits + ' unused icon fields');
