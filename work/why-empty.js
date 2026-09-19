/* Which branch of staffWindows is returning nothing? Usage: node work/why-empty.js */
'use strict';
var path = require('path');
var GH = require(path.join(__dirname, '..', 'outputs/demo/engine.js'));
var DATA = require(path.join(__dirname, '..', 'outputs/demo/data.js'));

var state = GH.createState(DATA);
var salon = GH.getSalon(state, 'goldenhue');
var st = GH.getStaff(state, 'ramesh');

['2026-09-21', '2026-09-22', '2026-09-23'].forEach(function (day) {
  var wd = GH.weekdayOf(day);
  console.log(day + ' wd=' + wd +
    ' closed=' + JSON.stringify(salon.closed[day]) +
    ' staffHours=' + JSON.stringify(st.hoursMin[wd]) +
    ' salonHours=' + JSON.stringify(salon.hoursMin[wd]) +
    ' exceptions=' + JSON.stringify(st.exceptions.filter(function (e) { return e.date === day; })) +
    ' -> windows=' + JSON.stringify(GH.staffWindows(st, salon, day)));
});
