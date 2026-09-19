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

`render.yaml` is in the repository, so the button above deploys the whole thing:
the page, the API, the database on a disk, and a password prompted during setup.

It uses a paid instance on purpose. Render's free tier has an "ephemeral
filesystem" and states that local SQLite databases are "lost every time the
service redeploys, restarts, or spins down" — and free services spin down after 15
minutes idle. The database is the product here, so free would wipe every booking
several times a day.

`Dockerfile` is there for anywhere else that runs containers. What matters is a
persistent volume and `DB_FILE` pointing at it.

Two environment variables are worth knowing: `ADMIN_PASSWORD` sets the front-desk
password, and changing it later rotates it. `DB_FILE` says where the database
lives.

## Checking it

    powershell -File work/suite.ps1

Runs everything: the booking rules offline, the API, the browser flows, the design
audit at nine screen widths, and the two hardest cases — two servers racing for one
slot, and a booking surviving the server being replaced. Each can be run alone;
`work/` holds them.

## Photography

The images in `outputs/demo/img/` are openly licensed placeholders, credited in
`CREDITS.json`. Replace them with the salon's own.
