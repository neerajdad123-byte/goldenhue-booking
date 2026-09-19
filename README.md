# Goldenhue

White-label booking for salons. One codebase, many salons: a salon is a record,
not a deployment. Customers pick a service, a stylist and a time; the salon runs
its day from a front desk behind a password.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/neerajdad123-byte/goldenhue-booking)

Step by step, including what it costs and why: [DEPLOY.md](DEPLOY.md).

## Run it locally

    ADMIN_PASSWORD=your-password node outputs/demo/server.js

Then open http://localhost:3000 for the booking page and
http://localhost:3000/admin for the front desk. No dependencies to install: Node
24 and its own SQLite are the whole stack. Nothing to create first either, because
a shared secret is generated and stored on first boot.

## What it actually does

- **Availability is computed, never stored.** Working hours, breaks, leave,
  holidays, turnaround between customers and the bookings already on the books,
  turned into free slots at the moment of the request.
- **Double-booking is prevented by the database**, not by a check in the browser.
  The overlap test and the insert happen in one transaction. Two people clicking
  the same slot at the same moment, in two tabs, or through a hand-written API
  call: exactly one wins and the other is told the slot has gone.
- **Two servers can share one database.** A rolling deploy does not double-book,
  and does not lose a booking taken by the other instance. Tested, not assumed.
- **Open pages update themselves** when someone else books or cancels.
- **The front desk** edits prices, durations and each stylist's week, and those
  changes reach the booking page immediately, because both read the same rules.

## Where things are

| Path | What |
|---|---|
| `outputs/demo/engine.js` | The booking rules. No DOM, no framework. Runs in the browser and on the server. |
| `outputs/demo/store.js` | Every database call, behind one module. Includes the atomic booking guard. |
| `outputs/demo/server.js` | HTTP: booking, availability, live updates, the front desk. |
| `outputs/demo/admin.html` | The front desk. |
| `outputs/demo/auth.js` | Passwords and sessions, from Node's own crypto. |
| `outputs/demo/index.html` | The booking page. Also works as a static preview with no server. |
| `outputs/Goldenhue-V1-Plan.md` | Why it is built this way. |

## Hosting

Free, and no card: **Render** runs the app on its free tier, and **Neon** holds the
bookings on its free tier. The app is disposable and the database is not, which is
why this works without paying for a disk. `render.yaml` is in the repository, so
the button above deploys the whole thing.

Step by step: [DEPLOY.md](DEPLOY.md). The one catch is that Render stops a free
service after 15 minutes idle, so the first visitor waits about a minute. Nothing
is lost when that happens, because the bookings are at Neon.

Where the data lives is one environment variable. Unset, the app uses a local
SQLite file, which is what running it on your own machine does. Set to a Postgres
connection string, it uses that instead. `ADMIN_PASSWORD` sets the front-desk
password, and changing it later rotates it. `Dockerfile` is there for anywhere
else that runs containers.

## Checking it

    powershell -File work/suite.ps1

Runs everything: the booking rules offline, the API, the browser flows, the design
audit at nine screen widths, and the two hardest cases — two servers racing for one
slot, and a booking surviving the server being replaced. Each can be run alone;
`work/` holds them.

## Photography

The images in `outputs/demo/img/` are openly licensed placeholders, credited in
`CREDITS.json`. Replace them with the salon's own.
