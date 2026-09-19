# Goldenhue — where the build stands

## Open it

**Hosted:** https://neerajdad123-byte.github.io/goldenhue-booking/ — the design, live, for anyone.

The salon's own console runs at **http://localhost:3000/admin** alongside the
booking page. It is not hosted, because it writes.

**With the real backend:**

```
node outputs/demo/server.js      then open http://localhost:3000
```

That serves the same page against a real SQLite database: availability computed
server-side per stylist, bookings saved, and open pages pushed updates when someone
else books. The header badge says `Live` or `Preview` so there is never any doubt
which one you are looking at.

`outputs/demo/index.html` also works on its own, straight from disk. Deep links land on any step:

```
index.html                                                    step 1, the menu
index.html?service=gh-colour&staff=any&day=1&step=3           the diary
index.html?salon=cuttingroom&service=cr-cut&staff=arjun&day=1&step=3
```

## Progress

| Phase | What it is | State |
|---|---|---|
| P0 — the rules | Availability engine: hours, breaks, leave, holidays, buffers, lead time, service duration. Booking, conflict handling, cancellation. | **Done and tested** — 23 assertions in `test-engine.js` |
| P1 — the booking flow | The five screens a customer walks through, on the real rules, at every width, with photography and motion. | **Done as a preview** — 52 end-to-end checks in `work/flow.js` |
| P2 — the backend | A real database, server-computed availability, atomic booking, live updates. | **Done** — 47 HTTP checks in `work/api-test.js` |
| P3 — the admin console | The day by stylist, editable services, and each stylist's working week. | **Done** — 27 checks in `work/admin-test.js` |
| P4 — white-label finish | Subdomains, custom domains, confirmation email, .ics, cancel links. | Not started |

## Hosting it without your laptop

Short answer: **you do not need Firebase.** GitHub Pages hosts the customer page
today, for nothing, but it is static, so it cannot take a booking. Taking bookings
needs somewhere running `server.js`, and that somewhere needs a disk because the
database is a file.

| What you want | What to use | Cost |
|---|---|---|
| The booking page, public, no backend | **GitHub Pages**, already set up | Free |
| The whole thing, bookings saved, nobody's laptop involved | **Render**, from this repo: `render.yaml` is in it | Paid instance, because the disk is |
| The same, with a database that cannot lose data | **Firestore**, then Vercel or Firebase Hosting for the page | Blaze plan needs a card; usage is usually within the free allowance |

Firestore and Firebase are **not** required for hosting. The reason to move is a
database that survives a redeploy and a backup story you do not have to think
about, not hosting itself.

The awkward fact about Vercel and Netlify: serverless functions have no disk, so
SQLite there would lose every booking on each deploy. Pairing them with Firestore
is a legitimate setup, and it is why the storage seam exists.

**Roughly 20% of the finished product**, but the two things that decide whether the rest is easy — the availability rules and the double-booking defence — are settled, written down and verified. The remaining 80% is mostly screens and plumbing against a design that no longer moves.

## How double-booking is actually prevented

The overlap check and the insert run inside one `BEGIN IMMEDIATE` transaction
against SQLite, so the check cannot be overtaken between the two statements. The
test that matters fires **24 simultaneous bookings at a single slot** and asserts
that exactly one appointment exists afterwards; the other 23 receive
*"Sorry, this slot has just been booked. Please select another time."* It passes
against the real HTTP server, not a simulation.

The same guarantee holds for a stylist who cannot do a service: asking for one is
refused in the rules layer *and* in the booking path, so a hand-written API call
cannot sneak past the browser.

**The test that proves it runs two servers at once**, sharing one database file,
because that is the only configuration where the guarantee can actually fail. Node
is single-threaded and the SQLite driver is synchronous, so firing parallel requests
at one process cannot interleave a check with an insert: that test passes even if
the transaction is deleted, which makes it worthless. `work/race-test.js` starts two
processes, fires 24 simultaneous bookings at the same slot through both, and asserts
that exactly one appointment exists afterwards.

Building that test found three real bugs that only appear with more than one
process, which is exactly what a rolling deploy does:

1. **Both processes tried to seed the database**, and the loser died on boot with a
   duplicate key. The emptiness check sat outside the transaction. Seeding is now
   atomic, in all three tables.
2. **Availability was computed from an in-memory copy** of the bookings, so a
   booking taken by the other instance was still being offered here. The mirror is
   now refreshed from the store before anything is computed.
3. **Two simultaneous boots collided** on the journal-mode switch, which takes an
   exclusive lock and does not wait. It now retries.

## The live layer

Availability is recomputed on every request from the current time, the stylist's
shift, their breaks, leave, the salon's hours and the bookings on the books — so
nothing can be stale by construction. Open pages subscribe to a server-sent event
stream and refresh when someone else books or cancels, so two people looking at the
same diary see the same thing without refreshing.

Two limits are handled explicitly rather than left to chance. A browser allows only
a handful of connections per host, so the stream recycles itself every 90 seconds
instead of holding one for the life of the page. And a stream that goes quiet
without erroring — the half-open socket case — trips a watchdog that falls back to
polling, because a diary that looks fine while going stale is the worst outcome.

Without a server the page degrades to preview mode instead of breaking: same rules,
same screens, bookings kept in the tab.

## The design layer, and where it came from

The look was not invented in a vacuum. Three things were measured first:

- **Awwwards' own site** builds its type on a px+vw slope — `clamp(42px, -3.07px + 9.01vw, 170px)` — over a 12 column grid. The same technique is used here, so every heading scales smoothly from a 360px phone to a 1440px laptop with no breakpoint juggling.
- **Award winners stay light on libraries.** neutral.studio ships GSAP and Swiper; Warm & Fuzzy ships Lenis and nothing else. So this demo ships no motion library at all: the View Transitions API, the Web Animations API, IntersectionObserver and one requestAnimationFrame loop cover everything.
- **In beauty, the category convention is a saturated light against deep neutrals.** Glossier runs pink on black and white; Starface runs orange on white. Each demo salon therefore owns exactly one saturated colour, which drives the page, and everything else is near-black on white.

**Type was corrected once it was tested rather than admired.** The first build set
everything — headings and body — in a condensed poster face. It photographed well
and read badly: all-caps condensed is the slowest kind of text to scan, and this is
a page people use to book rather than a poster they walk past. Headings are now
**Fraunces**, a soft serif with optical sizing, and everything read up close is
**Plus Jakarta Sans**. Headings sit in sentence case instead of caps. Caps are kept
only where they belong: small labels, categories, and the vertical sign.

## The motion set

Restraint was the rule: nothing animates on a control people hit constantly, and every duration sits between 120ms and 460ms, on transforms and opacity only so it all stays on the compositor.

| Moment | What happens | Why |
|---|---|---|
| Page load | The salon name lights up letter by letter; the rule under it draws out | Identity, once per visit |
| Cover photo | A curtain lifts to uncover it, then it drifts slowly | The photograph is revealed, not just present |
| Choosing | The row you picked flies across the page and lands in the tag | You always know where your choice went |
| Changing step | Browser-native View Transition slides old and new | Direction is legible: forward and back differ |
| Headline | Each word rises out of its own mask | A step change feels like a page turn |
| Hovering a service | A photo card trails the cursor | Shows what you are buying |
| Choosing a day | One pill slides between dates | Continuity instead of a repaint |
| Choosing a time | A ring fires on the bar, the total flips digit by digit | Confirms a decision |
| Confirming | A stub arrives with a stamp that thwacks in, then one sweep of light | The one moment worth remembering |

## The front desk

The salon runs itself from `/admin`:

- **The day, by stylist** — who is in, what they are booked for, how much chair time
  is sold, and the day's takings. Refreshes itself when a booking lands, so the
  screen on the counter never disagrees with the phone in a customer's hand.
- **Services** — price, minutes, and the turnaround before the next customer.
- **Working hours** — each stylist's week, day by day.

Those last two are not cosmetic: they are the same data availability is computed
from. The tests prove it by editing a price and watching the booking page offer it,
lengthening a service and watching the day lose slots, and switching a day off and
watching that stylist disappear from it. The server validates every edit too, so a
typo is refused rather than allowed to break the diary.

## What the preview actually proves

- A 2-hour colour at 10:00 blocks 10:00 until 12:15 with its turnaround, and the next bookable time is 12:15. Cancelling gives the time straight back.
- Only stylists trained for the chosen service appear, with "anyone free" falling through to whoever can take it.
- Leave, holidays, half-days and lunch breaks all carve real holes in the day.
- The diary only offers time you can actually book, and the check runs on the way in as well as on the way out, so a page open since morning cannot book a slot someone else already took.

## What it is not, yet

The preview keeps its appointments in the browser tab. Nothing is saved, and two customers on two devices are only genuinely protected once the database constraint exists — that is the first thing P2 builds, and it is the one piece of the system that cannot be faked or deferred.

Time and money are held as whole minutes and whole paise, never floats.

## How it was checked

```
node outputs/demo/test-engine.js    rules, 23 assertions
node work/flow.js 9222             the whole booking flow, 28 assertions
node work/inspect.js 9222          layout, contrast, overflow, at 5 widths
node work/check-ui.js              every id and icon the script reaches for
```

Contrast, measured on the rendered page: body text 7.4:1, salon colour as text 6.2–6.7:1 across the three demo salons, dark ink on the salon's colour fill 5.9–14.2:1. All clear WCAG AA.

## Files

| File | Role |
|---|---|
| `outputs/demo/engine.js` | The rules. No DOM, no framework, runs in the browser and in Node. |
| `outputs/demo/data.js` | Three demo salons, twelve services, nine stylists, their weeks and their leave. |
| `outputs/demo/app.js` | Screens and interaction only. Every rule comes from engine.js. |
| `outputs/demo/index.html`, `styles.css` | The five screens. |
| `outputs/demo/test-engine.js` | The rule tests. |
| `outputs/Goldenhue-V1-Plan.md` | The full V1 plan, including the database design. |

The engine is deliberately a plain script with no framework, so its logic can move to server-side SQL in P2 without a rewrite: the browser becomes a client of the same rules instead of the owner of them.
