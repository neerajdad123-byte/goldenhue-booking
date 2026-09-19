# Goldenhue booking

A white-label booking page for salons. One codebase, many salons: the salon is a
record, not a deployment.

## Run it

    node server.js

Then open http://localhost:3000. First run creates `goldenhue.db` and seeds it with
a few example bookings so the diary does not look empty.

The salon's own console is at http://localhost:3000/admin: the day by stylist,
editable prices and durations, and each stylist's working week. Change anything
there and the booking page follows immediately.

The same folder also works as a plain static page. Opened straight from disk it
runs in preview mode: everything behaves the same, but bookings stay in the tab.
The badge in the header says which mode you are in.

## What is real when the server is running

- Availability is computed on the server for the moment of the request, per stylist.
- Bookings are written to SQLite, and the overlap check and the insert happen in one
  transaction, so two people clicking the same slot cannot both get it.
- Open pages receive a push when someone else books or cancels, so the diary is
  never quietly stale.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/catalog` | Salons, services and staff, in the shape the page consumes |
| `GET /api/availability?salon&service&staff&date` | Free slots, each naming the stylists who can take it |
| `GET /api/diary?salon&service&staff&date` | Per-stylist lanes: working hours, busy time, free time |
| `GET /api/staff-availability?salon&service` | The soonest each capable stylist is free |
| `POST /api/book` | Book. Returns 201, or 409 when the slot has just gone |
| `POST /api/cancel` | Cancel by reference |
| `GET /api/appointments?salon&date` | Everything booked that day, for the admin view |
| `GET /api/appointments-range?salon&from&to` | A window of bookings |
| `GET /api/stream?salon` | Server-sent events: bookings and cancellations as they happen |
| `GET /health` | Liveness and the appointment count |
| `GET /api/admin/summary?salon&date` | The day: a lane per stylist, bookings, takings |
| `GET /api/admin/config?salon` | Services, and each stylist's working week |
| `POST /api/admin/service` | Change a service's price, duration, turnaround or availability |
| `POST /api/admin/hours` | Replace a stylist's weekly pattern |

## Tests

    node test-engine.js          the booking rules, offline
    node ../work/api-test.js     the HTTP API against a running server

The one that matters is the race: `api-test.js` fires two dozen simultaneous
bookings at a single slot and asserts that exactly one appointment exists
afterwards.

## Deploying

Node 24 or newer, one small instance, and **a persistent disk**. There are no
dependencies to install and the database is a single file, so hosting is mostly a
question of where that file lives.

| Host | Works? | The catch |
|---|---|---|
| **Render** | Yes, from this repo | `render.yaml` is already here. The disk needs a paid instance; the free tier resets the database on every deploy. |
| **Fly, Cloud Run, a VPS** | Yes | `Dockerfile` is already here. Mount a volume at `/data`. |
| **Vercel, Netlify** | Only with a database swap | Serverless has no disk, so SQLite loses every booking on redeploy. Needs Postgres. |
| **GitHub Pages** | The page only | Static hosting cannot run a server, so the page falls back to preview mode. This is what the public demo is. |
| **Firebase** | Yes, after a rewrite | Hosting plus Cloud Functions plus Firestore. See below. |

Set `PORT` to change the port and `DB_FILE` to move the database. Both are read
from the environment.

### Moving to Firestore

All storage sits behind `store.js`, so this is a second implementation of one
file, not a rewrite of the application. `store.bookWithGuard()` is the method that
has to keep its guarantee; the notes at the bottom of that file describe the lock
document and transaction shape that replaces SQLite's exclusion check.

The reason to move is concurrency or managed backups, not hosting. SQLite on a
disk already does the job for a salon.

Note that Firebase's Cloud Functions need the Blaze plan, which is pay-as-you-go
with a card on file, even though the monthly allowance usually costs nothing.

## Photography

The images in `img/` are openly licensed placeholders, credited in
`img/CREDITS.json`. Replace them with the salon's own photographs before launch.
