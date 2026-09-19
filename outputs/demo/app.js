/* UI wiring. All booking rules live in engine.js; this file draws and dispatches.

   The rail is the wide-screen view of a day: one row per stylist, time running
   left to right, lit bars where they are genuinely free. Narrow screens get chips
   instead, from the same availability call. CSS decides which is visible. */
(function () {
  'use strict';

  var E = GH;
  var HOUR_W = 68;
  var HEAD = {
    1: ['01 / Service', 'What are we doing today?', 'Sit down, look through the list. Prices are final, there is nothing to pay now.'],
    2: ['02 / Stylist', "Who's doing it?", 'Pick someone you know, or take whoever is free first and get in sooner.'],
    3: ['03 / Time', 'When works for you?', 'Every lit bar is a real gap in that stylist’s diary. Taken time stays dark.'],
    4: ['04 / Details', 'Who are we expecting?', 'We will text a reminder the day before. Pay at the salon when you are done.'],
    5: ['Booked', 'You are on the books.', '']
  };

  var state = E.createState(DATA);
  var ui = {};
  var slotsTimer = null;
  var toastTimer = null;
  var lastTotal = '';
  var dir = 1;
  var revealing = false;
  var stepping = false;

  /* When the page is served by server.js the bookings are real: reads are mirrored
     from the database and a push channel keeps the diary current. Opened straight
     from disk there is no server, so it falls back to a local preview and says so. */
  var API = { live: false, stream: null, pending: null };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function firstName(full) { return String(full).split(' ')[0]; }
  function initials(full) {
    return String(full).split(' ').slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase();
  }
  /* read on the salon's clock, so a customer browsing from another timezone still
     sees and books the times the salon means */
  function minutesOf(d) { return E.wallMinutes(d, salon().tz); }

  function reset() {
    state = E.createState(DATA);
    ui = {
      salonId: 'goldenhue', step: 1, serviceId: null, staffId: null,
      dateISO: E.todayYmd(), startISO: null, pickStaffIds: [],
      booking: null, cancelled: false, loading: false,
      category: null, autoScrollRail: false
    };
    lastTotal = '';
  }

  function salon() { return E.getSalon(state, ui.salonId); }
  function service() { return ui.serviceId ? E.getService(state, ui.serviceId) : null; }
  function staff() { return ui.staffId ? E.getStaff(state, ui.staffId) : null; }
  function chosenStylistName() {
    if (ui.staffId) { return staff().name; }
    if (ui.pickStaffIds.length) { return E.getStaff(state, ui.pickStaffIds[0]).name; }
    return 'Whoever is free';
  }

  /* ---------- the room ---------- */

  function renderRoom() {
    var s = salon(), root = document.documentElement.style;
    root.setProperty('--brand', s.brand.light);
    root.setProperty('--brand-ink', s.brand.ink);
    root.setProperty('--brand-deep', s.brand.deep);
    document.title = 'Book at ' + s.name;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', s.brand.light); }

    /* The sign lights up letter by letter. First paint only, so it earns the motion. */
    if (el('brandBlade').dataset.salon !== s.id) {
      el('brandBlade').dataset.salon = s.id;
      el('brandBlade').innerHTML = s.name.split('').map(function (ch, i) {
        return '<span style="--i:' + i + '">' + (ch === ' ' ? '&nbsp;' : esc(ch)) + '</span>';
      }).join('');
    }

    var st = openState(s);
    el('signState').textContent = st.label;
    el('signState').classList.toggle('closed', !st.open);
    el('signTagline').textContent = s.tagline;
    el('signAddress').textContent = s.address;
    el('signPhone').textContent = s.phone;
    el('stubSalon').textContent = s.name;

    var picker = el('salonPicker');
    if (picker.options.length !== state.salons.length) {
      picker.innerHTML = state.salons.map(function (x) {
        return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>';
      }).join('');
    }
    picker.value = ui.salonId;
    el('rivalBtn').disabled = !(ui.step === 3 && !!ui.serviceId);
  }

  function openState(s) {
    var today = E.todayYmd();
    if (s.closed[today]) { return { open: false, label: 'Closed today' }; }
    var w = s.hoursMin[E.weekdayOf(today)];
    if (!w.length) { return { open: false, label: 'Closed today' }; }
    var now = minutesOf(new Date());
    if (w.some(function (x) { return now >= x.start && now < x.end; })) { return { open: true, label: 'Open now' }; }
    return { open: false, label: now < w[0].start ? 'Opens ' + E.clockLabel(w[0].start) : 'Closed for today' };
  }

  /* ---------- head ---------- */

  function renderHead() {
    var copy = HEAD[ui.step];
    /* Step one belongs to the salon: its own line, not a generic prompt. */
    if (ui.step === 1) { copy = [copy[0], salon().headline, salon().sub]; }
    el('stepKicker').textContent = copy[0];
    renderHeadline(copy[1]);
    el('stepSub').textContent = copy[2];
    renderNextFree();
    Array.prototype.forEach.call(el('stepper').querySelectorAll('.crumb'), function (b) {
      var step = +b.dataset.step;
      b.classList.toggle('active', step === ui.step);
      b.classList.toggle('done', step < ui.step);
      b.disabled = !(step < ui.step);
    });
  }

  /* Each word rises out of its own mask. Cheap, and it makes a step change feel
     like a page turn rather than a swap. */
  function renderHeadline(text) {
    var node = el('stepHeadline');
    if (node.dataset.text === text) { return; }
    node.dataset.text = text;
    node.innerHTML = String(text).split(' ').map(function (word, i) {
      return '<span class="w" style="--i:' + i + '"><i>' + esc(word) + '</i></span>';
    }).join(' ');
  }

  /* ---------- photography ---------- */

  function loadImage(img, src, host) {
    if (!src) { return; }
    img.src = src;
    var done = function () { if (host) { host.classList.add('ready'); } };
    if (img.complete && img.naturalWidth) { done(); } else {
      img.addEventListener('load', done, { once: true });
      /* a missing photograph must never leave a broken frame behind */
      img.addEventListener('error', function () { if (host) { host.classList.add('missing'); } }, { once: true });
    }
  }

  function renderCover() {
    var s = salon();
    loadImage(el('coverImg'), s.cover, el('cover'));
  }

  /* The work band: the salon's own shots drifting past, un-saturating to full
     colour under the cursor. Two identical runs make the loop seamless. */
  function renderGallery() {
    var run = function () {
      /* Each half of the loop carries the pictures twice, so a wide screen never
         scrolls into a gap before the repeat arrives. */
      var pics = salon().gallery.concat(salon().gallery);
      return pics.map(function (src, i) {
        /* eager on purpose: the band never stops moving, and a lazy picture would
           arrive as a blank frame sliding across the page */
        return '<figure class="shot" style="--i:' + i + '"><img src="' + esc(src) + '" alt="" decoding="async"></figure>';
      }).join('');
    };
    el('galleryRun').innerHTML = run() + run();
  }

  /* The cursor-follow preview: hovering a service shows what that service looks
     like. Pointer devices only, because on a phone it would be a card glued to
     the last tap. */
  var peekPos = { x: 0, y: 0, tx: 0, ty: 0, live: false, drawn: false };

  function peekFine() { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }

  function peekShow(item) {
    if (!peekFine()) { return; }
    var svc = E.getService(state, item.dataset.id);
    if (!svc || !svc.photo) { return; }
    var box = el('peek'), img = el('peekImg');
    if (img.getAttribute('src') !== svc.photo) { img.src = svc.photo; }
    el('peekLabel').textContent = svc.name;
    box.classList.add('on');
    peekPos.live = true;
    if (!peekPos.drawn) { peekPos.drawn = true; peekLoop(); }
  }

  function peekMove(e) {
    if (!el('peek').classList.contains('on')) { return; }
    /* offset so the card sits beside the cursor, never under it */
    peekPos.tx = e.clientX + 22;
    peekPos.ty = e.clientY - 74;
    if (!peekPos.live) { peekPos.x = peekPos.tx; peekPos.y = peekPos.ty; }
    peekPos.live = true;
  }

  function peekHide() {
    el('peek').classList.remove('on');
    peekPos.live = false;
  }

  function peekLoop() {
    requestAnimationFrame(peekLoop);
    var box = el('peek');
    if (!box.classList.contains('on')) { return; }
    /* lerp, so the card trails the cursor instead of snapping to it */
    peekPos.x += (peekPos.tx - peekPos.x) * 0.16;
    peekPos.y += (peekPos.ty - peekPos.y) * 0.16;
    box.style.transform = 'translate3d(' + peekPos.x.toFixed(1) + 'px,' + peekPos.y.toFixed(1) + 'px,0)';
  }

  /* The band gets a little vertical parallax so it feels like a layer, not a strip. */
  function parallaxBand() {
    var shots = el('galleryRun');
    if (!shots || !shots.children.length) { return; }
    var r = shots.getBoundingClientRect();
    if (r.bottom < -200 || r.top > window.innerHeight + 200) { return; }
    var fromCentre = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
    Array.prototype.forEach.call(shots.children, function (shot, i) {
      var depth = (i % 3) - 1;
      shot.style.setProperty('--py', (fromCentre * 26 * depth).toFixed(1) + 'px');
    });
  }

  /* The shortcut that saves the most time: name the soonest chair, and put the
     customer straight on it, skipping the stylist question entirely. */
  function renderNextFree() {
    var btn = el('nextFreeBtn'), label = el('nextFreeText');
    var svc = service();
    if (!svc) {
      btn.disabled = true;
      label.textContent = 'Pick a service to see the soonest chair';
      return;
    }
    btn.disabled = false;
    var got = E.earliestSlot(state, { salonId: ui.salonId, serviceId: svc.id, staffId: ui.staffId, days: 14 });
    if (!got) { btn.disabled = true; label.textContent = 'Nothing free in the next two weeks'; return; }
    var p = E.dateParts(got.dateISO);
    var who = ui.staffId ? firstName(staff().name)
      : (got.staffIds.length > 1 ? 'any of ' + got.staffIds.length : firstName(E.getStaff(state, got.staffIds[0]).name));
    label.innerHTML = 'Soonest: <b>' + (p.isToday ? 'today' : p.dow + ' ' + p.day + ' ' + p.month) + ', ' +
      E.clockLabel(got.startMin) + '</b> with ' + esc(who);
  }

  /* ---------- category filter ---------- */

  function renderFilters() {
    var list = E.servicesForSalon(state, ui.salonId);
    var counts = {};
    list.forEach(function (v) { counts[v.category] = (counts[v.category] || 0) + 1; });
    var cats = Object.keys(counts).sort();
    if (cats.length < 2) { el('filters').innerHTML = ''; return; }
    var all = '<button type="button" class="filter" data-cat="" aria-pressed="' + (ui.category === null) + '">' +
      'Everything<span class="count">' + list.length + '</span></button>';
    el('filters').innerHTML = all + cats.map(function (c) {
      return '<button type="button" class="filter" data-cat="' + esc(c) + '" aria-pressed="' + (ui.category === c) + '">' +
        esc(c) + '<span class="count">' + counts[c] + '</span></button>';
    }).join('');
  }

  /* ---------- reviews and footer ---------- */

  function renderReviews() {
    var run = function () {
      return salon().reviews.map(function (r) {
        return '<figure class="quote"><p>&ldquo;' + esc(r.text) + '&rdquo;</p>' +
          '<footer><span class="who">' + esc(r.name) + '</span><span class="what">' + esc(r.service) + '</span></footer></figure>';
      }).join('');
    };
    /* two identical runs side by side so the loop has no seam */
    el('reviewsTrack').innerHTML = '<div class="reviews-run">' + run() + '</div><div class="reviews-run" aria-hidden="true">' + run() + '</div>';
  }

  function renderFoot() {
    var s = salon();
    var wd = E.weekdayOf(E.todayYmd());
    var week = E.DAY_NAMES.map(function (name, i) {
      var w = s.hoursMin[i];
      return '<li>' + name.slice(0, 3) + ' <span>' + (w.length ? E.clockLabel(w[0].start) + ' to ' + E.clockLabel(w[w.length - 1].end) : 'Closed') + '</span></li>';
    }).join('');
    el('foot').innerHTML =
      '<div class="reveal"><p class="foot-brand">' + esc(s.name) + '</p>' +
        '<p style="margin-top:8px">' + esc(s.tagline) + '</p><div class="foot-rule"></div></div>' +
      '<div class="reveal"><h3>Find us</h3><p>' + esc(s.address) + '</p><p style="margin-top:6px">' + esc(s.phone) + '</p></div>' +
      '<div class="reveal"><h3>Opening hours</h3><ul>' + week + '</ul></div>' +
      '<div class="reveal"><h3>Booking</h3><ul>' +
        '<li>Free cancellation up to <span>' + s.cancellationHours + ' hours</span> before</li>' +
        '<li>Pay in the salon, <span>nothing now</span></li>' +
        '<li>Today is <span>' + E.DAY_NAMES[wd] + '</span></li>' +
      '</ul></div>';
  }

  /* ---------- reveal, once per element ---------- */

  function observeReveals() {
    var targets = document.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(targets, function (t) { t.classList.add('in'); });
      return;
    }
    if (!revealing) {
      revealing = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); revealing.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: .05 });
    }
    Array.prototype.forEach.call(targets, function (t) { revealing.observe(t); });
  }

  /* ---------- step changes ---------- */

  /* Where the browser supports View Transitions the step change gets a real
     snapshot morph, slide and all. Everywhere else the CSS animation already on
     .panel does the job, so this is a straight upgrade with no fallback code. */
  function goStep(next, after) {
    var apply = function () { ui.step = next; renderAll(); };
    var run = after || function () {};
    if (stepping || !document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply();
      run();
      return;
    }
    stepping = true;
    var vt = document.startViewTransition(apply);
    var done = function () { stepping = false; run(); };
    if (vt && vt.finished) { vt.finished.then(done, done); } else { done(); }
  }

  /* The reviews band and the footer only change when the salon does, so they are
     not rebuilt on every click. Rebuilding would restart the marquee mid-stride. */
  var builtFor = null;
  function renderStatic() {
    if (builtFor === ui.salonId) { return; }
    builtFor = ui.salonId;
    renderReviews();
    renderFoot();
    renderGallery();
  }

  function showPanel() {
    for (var i = 1; i <= 5; i += 1) {
      var p = el('panel-' + i);
      p.hidden = i !== ui.step;
      /* only the visible panel carries the name, so a transition never has to guess
         which one moved */
      p.dataset.active = i === ui.step ? '1' : '';
    }
  }

  /* ---------- 1. menu ---------- */

  function renderMenu() {
    var list = E.servicesForSalon(state, ui.salonId).filter(function (v) {
      return !ui.category || v.category === ui.category;
    });
    el('serviceList').innerHTML = list.map(function (v) {
      return '<li class="menu-row"><button type="button" class="menu-item" data-id="' + esc(v.id) + '"' +
        ' aria-pressed="' + (ui.serviceId === v.id) + '">' +
        '<span class="menu-name">' + esc(v.name) + '</span>' +
        '<span class="menu-price">' + E.formatINR(v.price) + '</span>' +
        '<span class="menu-desc">' + esc(v.desc) + '</span>' +
        '<span class="menu-meta"><span class="menu-cat">' + esc(v.category) + '</span>' +
          E.durationLabel(v.durationMin) + (v.bufferMin ? ' + ' + v.bufferMin + ' min turnaround' : '') +
        '</span></button></li>';
    }).join('');
  }

  /* ---------- 2. crew ---------- */

  function crewFlag(st, day) {
    if (E.staffWindows(st, salon(), day).length) { return ''; }
    var ex = st.exceptions.filter(function (x) { return x.date === day; })[0];
    if (ex && ex.kind === 'day_off') { return 'On leave: ' + ex.reason; }
    if (salon().closed[day]) { return 'Salon closed: ' + salon().closed[day]; }
    return 'Not in today';
  }

  function renderCrew() {
    var svc = service();
    if (!svc) { return; }
    var list = E.eligibleStaff(state, ui.salonId, svc.id);
    var html = '<li><button type="button" class="crew-item" data-id="any" aria-pressed="' + (ui.staffId === null) + '">' +
      '<span class="portrait any">&mdash;</span>' +
      '<span><span class="crew-name">Anyone free</span>' +
      '<span class="crew-role">Fastest way in</span>' +
      '<span class="crew-bio">We put you with whoever is free at the time you pick.</span></span>' +
      '<span class="crew-dur">' + E.durationLabel(svc.durationMin) + '</span></button></li>';

    html += list.map(function (st) {
      var flag = crewFlag(st, ui.dateISO);
      return '<li><button type="button" class="crew-item" data-id="' + esc(st.id) + '" aria-pressed="' + (ui.staffId === st.id) + '">' +
        '<span class="portrait">' + esc(initials(st.name)) + '</span>' +
        '<span><span class="crew-name">' + esc(st.name) + '</span>' +
        '<span class="crew-role">' + esc(st.title) + '</span>' +
        '<span class="crew-bio">' + esc(st.bio) + '</span>' +
        '<span class="crew-tags">' + st.services.map(function (id) {
          return '<span class="tag">' + esc(E.getService(state, id).name) + '</span>';
        }).join('') + '</span>' +
        (flag ? '<span class="crew-flag">' + esc(flag) + '</span>' : '') +
        '<span class="crew-next">' + (API.live ? 'Checking their diary' : '') + '</span>' +
        '</span>' +
        '<span class="crew-dur">' + E.durationLabel(svc.durationMin) + '</span></button></li>';
    }).join('');
    el('staffList').innerHTML = html;
  }

  /* ---------- 3. days ---------- */

  function renderDays() {
    el('dayRail').innerHTML = '<span class="day-float" id="dayFloat" aria-hidden="true"></span>' +
      E.nextDays(salon(), 14).map(function (d) {
      var p = E.dateParts(d.date);
      return '<button type="button" class="day' + (d.closed ? ' closed' : '') + '" data-date="' + esc(d.date) + '"' +
        ' aria-pressed="' + (ui.dateISO === d.date) + '"' + (d.closed ? ' disabled title="' + esc(d.reason) + '"' : '') + '>' +
        '<span class="dow">' + (p.isToday ? 'Today' : p.dow) + '</span>' +
        '<span class="dnum">' + p.day + '</span>' +
        '<span class="dmon">' + p.month + '</span></button>';
    }).join('');
  }

  /* The selection pill slides between days rather than repainting each one.
     First placement is instant so it does not fly in from the corner. */
  function placeDayFloat(animate) {
    var active = el('dayRail').querySelector('.day[aria-pressed="true"]');
    var pill = el('dayFloat');
    if (!active || !pill) { return; }
    if (!animate) { pill.style.transition = 'none'; }
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.transform = 'translate(' + active.offsetLeft + 'px,' + active.offsetTop + 'px)';
    if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
  }

  function setDir(d) {
    dir = d;
    document.documentElement.style.setProperty('--dir', String(dir));
  }

  /* The one moment worth remembering: whatever you just chose flies across the
     page and lands in the tag, so you always know where your selection went.
     Web Animations only, no library, transform and opacity only. */
  function flyTo(fromEl, toEl) {
    if (!fromEl || !toEl) { return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }
    var a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (a.width < 2 || b.width < 2) { return; }

    var ghost = fromEl.cloneNode(true);
    ghost.classList.add('flight');
    ghost.removeAttribute('id');
    /* Decoration only: it must not show up as a second button to a screen reader,
       a query, or the tab order while it is in the air. */
    ghost.removeAttribute('aria-pressed');
    ghost.removeAttribute('data-start');
    ghost.removeAttribute('data-staff');
    ghost.setAttribute('aria-hidden', 'true');
    if (ghost.tagName === 'BUTTON') { ghost.disabled = true; ghost.tabIndex = -1; }
    ghost.style.left = a.left + 'px';
    ghost.style.top = a.top + 'px';
    ghost.style.width = a.width + 'px';
    ghost.style.height = a.height + 'px';
    var look = getComputedStyle(fromEl);
    ghost.style.font = look.font;
    ghost.style.color = look.color;
    document.body.appendChild(ghost);

    var dx = b.left - a.left, dy = b.top - a.top;
    var sx = Math.max(b.width / a.width, .35), sy = Math.max(b.height / a.height, .35);
    ghost.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(' + (dx * .55) + 'px,' + (dy * .55) + 'px) scale(' + ((1 + sx) / 2) + ',' + ((1 + sy) / 2) + ')', opacity: .9, offset: .55 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', opacity: 0 }
    ], { duration: 460, easing: 'cubic-bezier(.16,1,.3,1)' }).onfinish = function () { ghost.remove(); };

    toEl.animate(
      [{ opacity: .25, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }],
      { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' }
    );
  }

  function inTag(key) { return el('clipTag').querySelector('[data-k="' + key + '"] .v'); }

  /* ---------- 3. the rail ---------- */

  function renderRail() {
    var wrap = el('railScroll');
    var svc = service();
    if (!svc) { wrap.innerHTML = ''; return; }

    var lanes = E.diaryLanes(state, {
      salonId: ui.salonId, serviceId: svc.id, staffId: ui.staffId, dateISO: ui.dateISO
    });
    var need = svc.durationMin + svc.bufferMin;

    var starts = [], ends = [];
    lanes.forEach(function (l) {
      l.windows.forEach(function (w) { starts.push(w.start); ends.push(w.end); });
    });
    if (!starts.length) {
      var closed = salon().closed[ui.dateISO];
      wrap.innerHTML = emptyHTML(
        closed ? 'Closed that day' : 'Nobody is in',
        closed || ('No stylist who can do ' + svc.name.toLowerCase() + ' is working on this date. Try another day.')
      );
      return;
    }

    var dayStart = Math.floor(Math.min.apply(null, starts) / 60) * 60;
    var dayEnd = Math.ceil(Math.max.apply(null, ends) / 60) * 60;
    var trackW = (dayEnd - dayStart) / 60 * HOUR_W;
    var x = function (mins) { return (mins - dayStart) / 60 * HOUR_W; };

    var ticks = '';
    for (var t = dayStart; t <= dayEnd; t += 60) {
      ticks += '<div class="tick" style="left:' + x(t) + 'px">' + E.clockLabel(t) + '</div>';
    }

    var nowMins = minutesOf(new Date());
    var showNow = ui.dateISO === E.todayYmd() && nowMins > dayStart && nowMins < dayEnd;

    var rows = lanes.map(function (lane, li) {
      var off = !lane.windows.length;
      var blocks = '';
      var index = 0;

      lane.busy.forEach(function (b) {
        blocks += '<div class="blk blk-taken" style="left:' + x(b.start) + 'px;width:' + Math.max(x(b.end) - x(b.start) - 2, 3) + 'px" title="Booked"></div>';
      });

      lane.free.forEach(function (f) {
        var span = f.end - f.start;
        var left = x(f.start), width = Math.max(x(f.end) - left - 2, 3);
        if (span < need) {
          blocks += '<div class="blk blk-short" style="left:' + left + 'px;width:' + width + 'px" ' +
            'title="' + span + ' minutes free, this service needs ' + need + '"></div>';
          return;
        }
        var iso = E.atMinutes(ui.dateISO, f.start, salon().tz).toISOString();
        var delay = Math.min(index * 26, 320);
        index += 1;
        blocks += '<button type="button" class="blk blk-free" data-start="' + esc(iso) + '" data-staff="' + esc(lane.staff.id) + '"' +
          ' aria-pressed="' + isPicked(iso, lane.staff.id) + '" style="left:' + left + 'px;width:' + width + 'px;animation-delay:' + delay + 'ms">' +
          '<span class="blk-time">' + E.clockLabel(f.start) + '</span>' +
          (span >= 60 ? '<span class="blk-len">' + E.durationLabel(span) + ' free</span>' : '') +
        '</button>';
      });

      if (showNow) { blocks += '<div class="nowline" style="left:' + x(nowMins) + 'px"></div>'; }

      return '<div class="rail-row">' +
        '<div class="lane-name"><b>' + esc(firstName(lane.staff.name)) + '</b>' +
          '<span>' + (off ? 'Off today' : esc(lane.staff.title.split('\u00B7')[0].trim())) + '</span></div>' +
        '<div class="lane-track' + (off ? ' off' : '') + '" style="width:' + trackW + 'px">' + blocks + '</div>' +
      '</div>';
    }).join('');

    wrap.innerHTML = '<div class="rail-grid">' +
      '<div class="rail-ruler"><div class="ruler-pad"></div>' +
        '<div class="ruler-track" style="width:' + trackW + 'px">' + ticks + '</div></div>' +
      rows + '</div>';

    /* A day can start at 9am while the first free gap is at 2pm, so bring it into
       view rather than making the customer scrub to find it. Only when the day is
       freshly opened, never while they are working the rail themselves. */
    if (ui.autoScrollRail) {
      ui.autoScrollRail = false;
      var first = wrap.querySelector('.blk-free');
      if (first && first.offsetLeft > 40) { wrap.scrollLeft = Math.max(first.offsetLeft - 12, 0); }
    }
  }

  /* Two stylists can be free at the same minute. A pressed bar has to match the
     stylist as well as the time, or choosing one lights up the other. */
  function isPicked(iso, staffId) {
    return ui.startISO === iso && ui.pickStaffIds.indexOf(staffId) >= 0;
  }

  function sameCrew(a, b) {
    if (!a || !b || a.length !== b.length) { return false; }
    var left = a.slice().sort().join(','), right = b.slice().sort().join(',');
    return left === right;
  }

  function emptyHTML(title, note) {
    return '<div class="empty"><svg class="ico"><use href="#i-empty"></use></svg>' +
      '<strong>' + esc(title) + '</strong><p>' + esc(note) + '</p></div>';
  }

  /* ---------- 3. the chips, narrow screens only ---------- */

  function renderChips() {
    var area = el('slotArea');
    var svc = service();
    if (!svc) { area.innerHTML = ''; return; }
    if (ui.loading) {
      area.innerHTML = '<div class="slot-group"><h3>Checking the diary</h3><div class="slot-grid">' +
        new Array(10).join('<div class="skeleton"></div>') + '</div></div>';
      return;
    }

    var res = E.availableSlots(state, {
      salonId: ui.salonId, serviceId: svc.id, staffId: ui.staffId, dateISO: ui.dateISO, now: new Date()
    });
    if (!res.slots.length) {
      var title = 'No times left', note = 'Every gap on this day is taken or outside working hours.';
      if (res.closedReason) { title = 'Closed'; note = res.closedReason; }
      else if (res.reason === 'FULLY_BOOKED') { title = 'Booked out'; note = 'Try another day, or someone else.'; }
      else if (res.reason === 'DAY_OFF') { title = 'Nobody is in'; note = 'No stylist who does this is working that day. Try another date.'; }
      else if (res.reason === 'NO_STAFF') { title = 'Nobody can take this'; note = 'Assign this service to a stylist first.'; }
      area.innerHTML = emptyHTML(title, note);
      return;
    }

    var groups = [
      { name: 'Morning', from: 0, to: 720 },
      { name: 'Afternoon', from: 720, to: 1020 },
      { name: 'Evening', from: 1020, to: 1440 }
    ];
    area.innerHTML = groups.map(function (g) {
      var inGroup = res.slots.filter(function (s) { return s.startMin >= g.from && s.startMin < g.to; });
      if (!inGroup.length) { return ''; }
      return '<div class="slot-group"><h3>' + g.name + '</h3><div class="slot-grid">' +
        inGroup.map(function (s) {
          var sub = ui.staffId ? firstName(staff().name)
            : (s.staffIds.length > 1 ? s.staffIds.length + ' free' : firstName(E.getStaff(state, s.staffIds[0]).name));
          return '<button type="button" class="slot" data-start="' + esc(s.startISO) + '"' +
            ' data-staff="' + esc(s.staffIds.join(',')) + '" aria-pressed="' +
            (ui.startISO === s.startISO && sameCrew(ui.pickStaffIds, s.staffIds)) + '">' +
            E.clockLabel(s.startMin) + '<span class="sub">' + esc(sub) + '</span></button>';
        }).join('') + '</div></div>';
    }).join('');
  }

  /* The pause is theatre: the real build awaits a server round trip here. */
  function loadSlots() {
    if (slotsTimer) { clearTimeout(slotsTimer); }
    ui.loading = true;
    renderChips();
    slotsTimer = setTimeout(function () { ui.loading = false; renderChips(); }, 220);
  }

  /* ---------- the clip ---------- */

  /* Split-flap numbers: only the digits that changed animate, like a departure board. */
  function renderTotal(text) {
    var before = lastTotal;
    lastTotal = text;
    return text.split('').map(function (ch, i) {
      var still = before.charAt(i) === ch;
      return '<span style="' + (still ? 'animation:none' : 'animation-delay:' + (i * 22) + 'ms') + '">' + esc(ch) + '</span>';
    }).join('');
  }

  function renderClip() {
    var svc = service();
    var when = ui.startISO
      ? E.dateParts(E.ymd(new Date(ui.startISO))).dow + ' ' + E.dateParts(E.ymd(new Date(ui.startISO))).day + ' ' +
        E.dateParts(E.ymd(new Date(ui.startISO))).month + ', ' + E.clockLabel(minutesOf(new Date(ui.startISO)))
      : 'Not picked';
    var rows = [
      ['stylist', 'Stylist', svc ? chosenStylistName() : 'Not picked'],
      ['when', 'When', when],
      ['length', 'Length', svc ? E.durationLabel(svc.durationMin) : 'Not picked']
    ].map(function (r) {
      return '<div class="clip-row" data-k="' + r[0] + '"><span class="k">' + esc(r[1]) + '</span><span class="v">' + esc(r[2]) + '</span></div>';
    }).join('');

    var cta = (ui.step === 3 && ui.startISO)
      ? '<button type="button" class="btn solid wide" data-action="continue">Continue</button>'
      : '<p class="clip-hint">' + esc(hintText()) + '</p>';

    el('clipTag').innerHTML =
      '<p class="clip-label">Your tag</p>' +
      '<p class="clip-salon">' + esc(salon().name) + '</p>' +
      '<p class="clip-service">' + esc(svc ? svc.name : 'Nothing picked yet') + '</p>' +
      '<div class="clip-rows">' + rows + '</div>' +
      '<div class="clip-total"><span class="k">Total</span>' +
        '<span class="total-digits">' + (svc ? renderTotal(E.formatINR(svc.price)) : '') + '</span></div>' +
      cta;
  }

  function hintText() {
    if (ui.step === 1) { return 'Pick something from the list and the tag fills itself in.'; }
    if (ui.step === 2) { return 'Choose a stylist, or let us pick whoever is free.'; }
    if (ui.step === 3) { return 'Tap a lit bar on the rail to lock a time.'; }
    if (ui.step === 4) { return 'Add your details to confirm.'; }
    return 'Booked. We will see you then.';
  }

  function renderBar() {
    var bar = el('actionBar');
    if (ui.step === 5) { bar.hidden = true; return; }
    bar.hidden = false;
    var svc = service(), bits = [];
    if (ui.staffId || ui.pickStaffIds.length) { bits.push(chosenStylistName()); }
    if (ui.startISO) { bits.push(E.clockLabel(minutesOf(new Date(ui.startISO)))); }
    var right = (ui.step === 3 && ui.startISO)
      ? '<button type="button" class="btn solid" data-action="continue">Continue</button>'
      : '<span class="bar-total">' + (svc ? E.formatINR(svc.price) : '') + '</span>';
    bar.innerHTML = '<div class="bar-text"><div class="bar-top">' + esc(svc ? svc.name : 'Pick a service') + '</div>' +
      '<div class="bar-sub">' + esc(bits.join(' \u00B7 ')) + '</div></div>' + right;
  }

  function renderPolicy() {
    var s = salon();
    el('signPolicy').textContent = 'Free to cancel up to ' + s.cancellationHours +
      ' hours before. Pay in the salon.';
  }

  /* ---------- 5. the stub ---------- */

  function renderStub() {
    var a = ui.booking, svc = E.getService(state, a.serviceId), st = E.getStaff(state, a.staffId), s = salon();
    var d = E.dateParts(a.day), startMin = minutesOf(a.startsAt);
    var stamp = el('stubStamp');
    stamp.textContent = ui.cancelled ? 'Cancelled' : 'Confirmed';
    stamp.classList.toggle('off', ui.cancelled);
    el('stubTitle').textContent = ui.cancelled
      ? 'Off the books.'
      : 'See you ' + d.dow + ', ' + firstName(a.customerName) + '.';
    el('stubSub').textContent = ui.cancelled
      ? 'That time is back on the rail for someone else.'
      : 'Confirmation going to ' + (a.customerPhone || a.customerName) + '. Come five minutes early, the kettle is on.';
    el('stubRef').textContent = a.ref;
    el('stubList').innerHTML = [
      ['Service', svc.name + ' / ' + E.durationLabel(svc.durationMin)],
      ['Stylist', st.name],
      ['When', d.dow + ' ' + d.day + ' ' + d.month + ', ' + E.clockLabel(startMin) + ' to ' + E.clockLabel(startMin + svc.durationMin)],
      ['Where', s.name + ', ' + s.address],
      ['Total', E.formatINR(a.price) + ' / pay in the salon']
    ].map(function (r) {
      return '<div class="clip-row"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>';
    }).join('');
    el('icsBtn').hidden = ui.cancelled;
    el('cancelBtn').hidden = ui.cancelled;
  }

  /* ---------- moves ---------- */

  function pickService(id) {
    ui.serviceId = id; ui.staffId = null; ui.pickStaffIds = []; ui.startISO = null;
    setDir(1);
    /* the flight starts once the step change has settled, so the two animations
       never fight over the same pixels */
    goStep(2, function () {
      flyTo(el('serviceList').querySelector('.menu-item[aria-pressed="true"] .menu-name'), el('clipTag').querySelector('.clip-service'));
    });
  }

  function pickStylist(id) {
    ui.staffId = id === 'any' ? null : id;
    ui.pickStaffIds = []; ui.startISO = null;
    ui.dateISO = firstOpenDay(ui.serviceId, ui.staffId);
    ui.autoScrollRail = true;
    setDir(1);
    goStep(3, function () {
      loadSlots();
      flyTo(el('staffList').querySelector('.crew-item[aria-pressed="true"] .crew-name'), inTag('stylist'));
    });
  }

  /* Landing on a day with nothing left reads as a broken site, so when the diary
     opens we look ahead for the first day this service can actually be booked.
     Late in the evening that is tomorrow, which is what a customer expects. */
  function firstOpenDay(serviceId, staffId) {
    var days = E.nextDays(salon(), 14);
    for (var i = 0; i < days.length; i += 1) {
      if (days[i].closed) { continue; }
      var res = E.availableSlots(state, {
        salonId: ui.salonId, serviceId: serviceId, staffId: staffId, dateISO: days[i].date, now: new Date()
      });
      if (res.slots.length) { return days[i].date; }
    }
    return E.todayYmd();
  }

  function pickDay(day) {
    ui.dateISO = day; ui.startISO = null; ui.pickStaffIds = [];
    ui.autoScrollRail = true;
    /* Same step, so the rail keeps its DOM and only the pill moves. */
    Array.prototype.forEach.call(el('dayRail').querySelectorAll('.day'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.date === day));
    });
    placeDayFloat(true);
    renderRail();
    renderClip();
    renderBar();
    loadSlots();
  }

  function pickTime(iso, staffIds) {
    ui.startISO = iso;
    ui.pickStaffIds = staffIds;
    renderRail();
    renderChips();
    renderClip();
    renderBar();
    var taken = el('railScroll').querySelector('.blk-free[aria-pressed="true"]') ||
                el('slotArea').querySelector('.slot[aria-pressed="true"]');
    flyTo(taken, inTag('when'));
  }

  function goToDetails() {
    if (!ui.startISO) { return; }
    setDir(1);
    goStep(4);
  }

  /* Skip the stylist question entirely: take whichever capable stylist is free
     soonest and drop the customer on that bar with it already selected. */
  function takeSoonest() {
    var svc = service();
    if (!svc) { return; }
    var got = E.earliestSlot(state, { salonId: ui.salonId, serviceId: svc.id, staffId: ui.staffId, days: 14 });
    if (!got) { toast('Nothing free in the next two weeks. Try another service.', 'info'); return; }
    ui.dateISO = got.dateISO;
    ui.startISO = got.startISO;
    ui.pickStaffIds = got.staffIds;
    ui.autoScrollRail = true;
    var p = E.dateParts(got.dateISO);
    var when = (p.isToday ? 'today' : p.dow + ' ' + p.day + ' ' + p.month) + ' at ' + E.clockLabel(got.startMin);
    if (ui.step < 3) {
      setDir(1);
      goStep(3, function () { toast('Jumped to the soonest chair: ' + when + '. Change it whenever you like.', 'info'); });
    } else {
      renderAll();
      toast('Moved to the soonest chair: ' + when + '.', 'info');
    }
  }

  function submitDetails(ev) {
    ev.preventDefault();
    var name = el('fName').value.trim();
    var phone = el('fPhone').value.replace(/[^0-9]/g, '');
    var email = el('fEmail').value.trim();
    var err = el('formError');
    if (name.length < 2) { err.textContent = 'We need a name for the diary.'; err.hidden = false; el('fName').focus(); return; }
    if (phone.length < 10) { err.textContent = 'A 10 digit mobile number, so the salon can reach you.'; err.hidden = false; el('fPhone').focus(); return; }
    err.hidden = true;

    var payload = {
      salonId: ui.salonId, serviceId: ui.serviceId,
      staffId: ui.staffId, preferStaffId: ui.pickStaffIds[0],
      startISO: ui.startISO,
      customer: { name: name, phone: phone, email: email, note: el('fNote').value.trim() }
    };

    if (API.live) {
      el('confirmBtn').disabled = true;
      el('confirmBtn').textContent = 'Checking the diary';
      api('api/book', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (res) {
        el('confirmBtn').disabled = false;
        el('confirmBtn').textContent = 'Lock it in';
        if (res.status === 201) { onBooked(serverToBooking(res.body)); return; }
        if (res.status === 409) {
          toast(res.body.message || E.SLOT_TAKEN_MESSAGE, 'error');
          ui.startISO = null; ui.pickStaffIds = []; ui.step = 3;
          renderAll();
          loadAppointments().then(function () { loadSlots(); });
          return;
        }
        toast(res.body.error || 'The booking could not be saved. Please try again.', 'error');
      }).catch(function () {
        el('confirmBtn').disabled = false;
        el('confirmBtn').textContent = 'Lock it in';
        toast('Could not reach the salon. Check your connection and try again.', 'error');
      });
      return;
    }

    /* No server: this is the preview, so the booking stays in this tab. */
    var out = E.book(state, payload);

    if (!out.ok) {
      toast(out.message, 'error');
      ui.startISO = null; ui.pickStaffIds = []; ui.step = 3;
      renderAll();
      loadSlots();
      return;
    }
    onBooked(out.appointment);
  }

  function serverToBooking(r) {
    return {
      id: r.id, ref: r.ref, salonId: r.salonId, staffId: r.staffId, serviceId: r.serviceId,
      customerName: el('fName').value.trim(), customerPhone: el('fPhone').value.replace(/[^0-9]/g, ''),
      startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt),
      day: r.day, price: r.price, status: 'booked'
    };
  }

  function onBooked(appointment) {
    ui.booking = appointment;
    ui.cancelled = false;
    ui.step = 5;
    renderAll();
    el('panel-5').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (API.live) { loadAppointments(); }
  }

  function addToCalendar() {
    var a = ui.booking, svc = E.getService(state, a.serviceId), st = E.getStaff(state, a.staffId), s = salon();
    function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Goldenhue//Booking//EN', 'BEGIN:VEVENT',
      'UID:' + a.ref + '@goldenhue',
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(a.startsAt),
      'DTEND:' + stamp(a.endsAt),
      'SUMMARY:' + svc.name + ' at ' + s.name,
      'LOCATION:' + s.address,
      'DESCRIPTION:Stylist: ' + st.name + ' | Ref: ' + a.ref,
      'END:VEVENT', 'END:VCALENDAR'
    ];
    var link = document.createElement('a');
    link.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
    link.download = a.ref + '.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function cancelBooking() {
    if (!ui.booking) { return; }
    if (API.live) {
      api('api/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: ui.booking.ref })
      }).then(function () {
        loadAppointments().then(function () { if (ui.step >= 3) { renderRail(); renderChips(); } });
      }).catch(function () { /* the stub already says cancelled */ });
    } else {
      E.cancel(state, ui.booking.ref);
    }
    ui.cancelled = true;
    renderStub();
    toast('Cancelled. ' + E.clockLabel(minutesOf(ui.booking.startsAt)) + ' is free again.', 'info');
  }

  /* The demo shortcut still works, but now it makes a genuine booking through the
     same endpoint the customer uses, so the race it demonstrates is a real one. */
  async function rivalBooking() {
    var svc = service();
    if (!svc) { return; }
    var res = E.availableSlots(state, { salonId: ui.salonId, serviceId: svc.id, staffId: ui.staffId, dateISO: ui.dateISO, now: new Date() });
    if (!res.slots.length) { toast('Nothing free left to take.', 'info'); return; }
    var target = res.slots[0];
    var staffId = ui.staffId || target.staffIds[0];
    var who = firstName(E.getStaff(state, staffId).name);

    if (API.live) {
      var out = await api('api/book', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          salonId: ui.salonId, serviceId: svc.id, staffId: staffId, startISO: target.startISO,
          customer: { name: 'Walk-in customer', phone: '' }
        })
      });
      if (out.status !== 201) { toast('That one had already gone.', 'info'); return; }
      /* deliberately do not refresh: the page is left stale, as a real one would be */
      toast('Another customer just took ' + E.clockLabel(target.startMin) + ' with ' + who +
        '. Your page still shows it free. Try to book it and watch the server say no.', 'info');
      return;
    }

    var local = E.book(state, {
      salonId: ui.salonId, serviceId: svc.id, staffId: staffId, startISO: target.startISO,
      customer: { name: 'Walk-in customer', phone: '', email: '' }
    });
    if (!local.ok) { toast('That bar was already gone.', 'info'); return; }
    toast('Another customer just took ' + E.clockLabel(target.startMin) + ' with ' + firstName(local.staff.name) +
      '. Your page still shows it free. Tap it and watch the server say no.', 'info');
  }

  function restart() {
    var salonId = ui.salonId;
    reset();
    ui.salonId = salonId;
    renderAll();
  }

  /* ---------- toast ---------- */

  /* ---------- talking to the server ---------- */

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    });
  }

  function setLiveState(on, note) {
    API.live = on;
    var badge = document.getElementById('liveBadge');
    if (!badge) { return; }
    badge.hidden = false;
    badge.textContent = on ? 'Live' : 'Preview';
    badge.classList.toggle('off', !on);
    badge.title = note || (on ? 'Connected. Availability and bookings are real.' : 'No server. Bookings stay in this tab.');
    /* The front desk writes, so it only exists where there is a server. Offering
       the link without one would be a dead end. */
    var adminLink = document.getElementById('adminLink');
    if (adminLink) { adminLink.hidden = !on; }
  }

  /* Replace the page's copy of the bookings for the window it can show, so
     availability keeps being computed from current data. */
  async function loadAppointments() {
    var from = E.todayYmd();
    var to = E.addDays(from, 15);
    var salonId = ui.salonId;
    try {
      var res = await api('api/appointments-range?salon=' + encodeURIComponent(salonId) + '&from=' + from + '&to=' + to);
      if (res.status !== 200 || ui.salonId !== salonId) { return false; }
      var rows = res.body.appointments.map(function (r) {
        return {
          id: r.id, ref: r.ref, salonId: r.salonId, staffId: r.staffId, serviceId: r.serviceId,
          customerName: r.customerName, customerPhone: r.customerPhone, customerEmail: r.customerEmail,
          note: r.note, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt),
          bufferUntil: new Date(r.bufferUntil), status: r.status, price: r.price, day: r.day
        };
      });
      /* keep anything local that the server does not know about yet */
      var seen = {};
      rows.forEach(function (r) { seen[r.ref] = 1; });
      var extras = state.appointments.filter(function (a) { return !seen[a.ref] && a.salonId === salonId; });
      state.appointments = state.appointments.filter(function (a) { return a.salonId !== salonId; }).concat(rows, extras);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* A push channel, so a booking made in another tab or on another phone shows up
     here without anyone refreshing. */
  function connectStream() {
    if (!API.live || typeof EventSource === 'undefined' || API.stream) { return; }
    var es = new EventSource('api/stream?salon=' + encodeURIComponent(ui.salonId));
    API.stream = es;
    es.onopen = function () {
      stopPolling();
      setLiveState(true);
      /* A browser allows only a handful of connections per host, so a long-lived
         stream holds one for the life of the page and enough open tabs starve
         everything else. Recycle it well before that becomes a problem: closing
         causes an immediate reconnect, and HTTP/2 hosts multiplex anyway. */
      if (API.recycle) { clearTimeout(API.recycle); }
      API.recycle = setTimeout(function () {
        API.recycle = null;
        if (API.stream) { API.stream.close(); API.stream = null; }
        connectStream();
      }, 90000);
    };
    es.onmessage = function (event) {
      API.lastPush = Date.now();
      var payload;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      if (!payload || payload.type === 'hello') { return; }
      if (API.pending) { clearTimeout(API.pending); }
      /* one refresh per burst, rather than one per event */
      API.pending = setTimeout(function () {
        API.pending = null;
        loadAppointments().then(function (ok) {
          if (!ok) { return; }
          if (ui.step >= 3) { renderRail(); renderChips(); renderCrew(); renderHead(); }
          noteLiveChange(payload);
        });
      }, 180);
    };
    /* Browsers cap concurrent connections per host, so a pile of open tabs can
       starve a stream. If the push channel cannot hold, fall back to asking the
       server periodically rather than letting the diary go quietly stale. */
    es.onerror = function () {
      startPolling();
      var badge = document.getElementById('liveBadge');
      if (badge) { badge.textContent = 'Reconnecting'; }
    };
    /* A stream that goes quiet without erroring is the dangerous case: the socket
       is open, nothing arrives, and the diary looks fine while going stale. */
    API.lastPush = Date.now();
    if (API.watchdog) { clearInterval(API.watchdog); }
    API.watchdog = setInterval(function () {
      if (Date.now() - (API.lastPush || 0) < 45000) { return; }
      API.lastPush = Date.now();
      loadAppointments().then(function () { if (ui.step >= 3) { renderRail(); renderChips(); } });
    }, 20000);
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer || !API.live) { return; }
    pollTimer = setInterval(function () {
      loadAppointments().then(function (ok) {
        if (!ok) { return; }
        if (ui.step >= 3) { renderRail(); renderChips(); }
      });
    }, 15000);
  }
  function stopPolling() {
    if (!pollTimer) { return; }
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function noteLiveChange(payload) {
    var who = payload.staffId ? E.getStaff(state, payload.staffId) : null;
    var when = typeof payload.startMin === 'number' ? E.clockLabel(payload.startMin) : '';
    if (payload.type === 'booked') {
      toast('Just booked: ' + when + ' with ' + (who ? firstName(who.name) : 'a stylist') + '. The diary has been updated.', 'info');
    } else if (payload.type === 'cancelled') {
      toast('Just freed up: ' + when + ' with ' + (who ? firstName(who.name) : 'a stylist') + '.', 'info');
    }
  }

  /* Per-stylist availability: what the soonest chair is for each person, shown on
     the crew rows so the choice can be made on real time rather than a hunch. */
  async function loadStaffAvailability() {
    if (!API.live || !ui.serviceId) { return; }
    var salonId = ui.salonId, serviceId = ui.serviceId;
    try {
      var res = await api('api/staff-availability?salon=' + encodeURIComponent(salonId) + '&service=' + encodeURIComponent(serviceId));
      if (res.status !== 200 || ui.salonId !== salonId || ui.serviceId !== serviceId) { return; }
      var byId = {};
      res.body.staff.forEach(function (s) { byId[s.staffId] = s.next; });
      Array.prototype.forEach.call(el('staffList').querySelectorAll('.crew-item'), function (row) {
        var next = byId[row.dataset.id];
        var slot = row.querySelector('.crew-next');
        if (!slot) { return; }
        if (!next) { slot.textContent = 'Nothing free in a fortnight'; slot.classList.add('none'); return; }
        var p = E.dateParts(next.day);
        slot.textContent = 'Next free ' + (p.isToday ? 'today' : p.dow + ' ' + p.day + ' ' + p.month) + ', ' + E.clockLabel(next.startMin);
      });
    } catch (e) { /* the row simply keeps the plain wording */ }
  }

  function toast(message, kind) {
    var t = el('toast');
    t.textContent = message;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.hidden = true; t.classList.remove('out'); }, 150);
    }, 7000);
  }

  /* ---------- render ---------- */

  function renderAll() {
    document.documentElement.style.setProperty('--dir', String(dir));
    renderRoom();
    renderCover();
    renderHead();
    renderFilters();
    renderMenu();
    renderStatic();
    if (ui.serviceId) { renderCrew(); }
    if (ui.step >= 3) { renderDays(); renderRail(); renderChips(); }
    if (ui.booking) { renderStub(); }
    renderClip();
    renderBar();
    renderPolicy();
    showPanel();
    /* Only measurable once the panel is actually on screen, otherwise every day
       reports a width of zero and the pill collapses. */
    placeDayFloat(false);
    observeReveals();
    if (ui.serviceId && API.live) { loadStaffAvailability(); }
  }

  /* ---------- events ---------- */

  function wire() {
    el('serviceList').addEventListener('click', function (e) {
      var item = e.target.closest('.menu-item');
      if (item) { pickService(item.dataset.id); }
    });
    el('serviceList').addEventListener('mouseover', function (e) {
      var item = e.target.closest('.menu-item');
      if (item) { peekShow(item); }
    });
    el('serviceList').addEventListener('mousemove', peekMove);
    el('serviceList').addEventListener('mouseleave', peekHide);
    el('staffList').addEventListener('click', function (e) {
      var item = e.target.closest('.crew-item');
      if (item) { pickStylist(item.dataset.id); }
    });
    el('dayRail').addEventListener('click', function (e) {
      var cell = e.target.closest('.day');
      if (cell && !cell.classList.contains('closed')) { pickDay(cell.dataset.date); }
    });
    el('railScroll').addEventListener('click', function (e) {
      var bar = e.target.closest('.blk-free');
      if (bar) { pickTime(bar.dataset.start, [bar.dataset.staff]); }
    });
    el('slotArea').addEventListener('click', function (e) {
      var slot = e.target.closest('.slot');
      if (slot) { pickTime(slot.dataset.start, slot.dataset.staff.split(',')); }
    });
    el('stepper').addEventListener('click', function (e) {
      var crumb = e.target.closest('.crumb');
      if (!crumb || crumb.disabled) { return; }
      setDir(+crumb.dataset.step >= ui.step ? 1 : -1);
      var target = +crumb.dataset.step;
      goStep(target, function () { if (target === 3) { loadSlots(); } });
    });
    el('filters').addEventListener('click', function (e) {
      var f = e.target.closest('.filter');
      if (!f) { return; }
      ui.category = f.dataset.cat || null;
      renderFilters();
      renderMenu();
    });
    el('nextFreeBtn').addEventListener('click', takeSoonest);
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-action="continue"]')) { goToDetails(); }
    });
    /* a tap anywhere else, or a pointer leaving the list, puts the card away */
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { peekHide(); } });
    el('detailsForm').addEventListener('submit', submitDetails);
    el('salonPicker').addEventListener('change', function (e) {
      /* the push channel is per salon, so it has to be rebuilt, not reused */
      if (API.stream) { API.stream.close(); API.stream = null; }
      reset();
      ui.salonId = e.target.value;
      builtFor = null;
      renderAll();
      if (API.live) {
        loadAppointments().then(function () { renderAll(); });
        connectStream();
      }
    });
    el('rivalBtn').addEventListener('click', rivalBooking);
    el('resetBtn').addEventListener('click', function () {
      restart();
      toast('Demo data reset.', 'info');
    });
    el('icsBtn').addEventListener('click', addToCalendar);
    el('cancelBtn').addEventListener('click', cancelBooking);
    el('againBtn').addEventListener('click', restart);
    /* scroll work is batched into one frame rather than one handler per event */
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) { return; }
      ticking = true;
      requestAnimationFrame(function () { parallaxBand(); ticking = false; });
    }, { passive: true });
  }

  /* A deep link so a screenshot or a shared URL can land on a later step:
     ?salon=goldenhue&service=gh-colour&staff=ramesh&day=1&step=3

     An explicit date=YYYY-MM-DD is also accepted, and preferred. An offset is
     relative to whichever day the reader thinks it is, which is not the same
     calendar everywhere: a link built from a UTC clock and opened by a salon on IST
     lands a day out. A date cannot be misread. */
  function applyDeepLink() {
    var q = new URLSearchParams(window.location.search);
    if (q.get('salon') && E.getSalon(state, q.get('salon'))) { ui.salonId = q.get('salon'); }
    var svc = q.get('service');
    if (svc && E.getService(state, svc)) { ui.serviceId = svc; ui.step = 2; }
    if (ui.serviceId && q.get('staff')) { ui.staffId = q.get('staff') === 'any' ? null : q.get('staff'); }
    var explicit = q.get('date');
    var day = parseInt(q.get('day'), 10);
    if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) { ui.dateISO = explicit; }
    else if (!isNaN(day)) { ui.dateISO = E.addDays(E.todayYmd(), day); }
    var step = parseInt(q.get('step'), 10);
    if (!isNaN(step) && step >= 1 && step <= 5) { ui.step = step; }
    if (!explicit && isNaN(day) && ui.serviceId && ui.step >= 3) { ui.dateISO = firstOpenDay(ui.serviceId, ui.staffId); }
  }

  async function boot() {
    var log = [];
    reset();
    setLiveState(false, 'Looking for the booking server');
    try {
      var cat = await api('api/catalog');
      log.push('catalog status=' + cat.status + ' salons=' + (cat.body && cat.body.salons ? cat.body.salons.length : 'none'));
      if (cat.status === 200 && cat.body && cat.body.salons && cat.body.salons.length) {
        /* the server is the salon's real catalogue, so build the page from it */
        DATA = cat.body;
        reset();
        setLiveState(true);
        log.push('went live');
      }
    } catch (e) {
      log.push('threw: ' + e.message);
      setLiveState(false);
    }
    log.push('live flag=' + API.live);
    wire();
    applyDeepLink();
    renderAll();
    if (API.live) {
      await loadAppointments();
      renderAll();
      connectStream();
      log.push('stream asked for');
    }
    /* a small handle so the page can be inspected and driven from the outside,
       which is how the automated checks talk to it */
    window.__gh = { api: API, ui: ui, state: state, engine: E, bootLog: log };
  }

  boot();
}());
