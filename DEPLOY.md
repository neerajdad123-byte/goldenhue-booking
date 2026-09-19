# Getting it online, free, once

After this the site runs whether your laptop is on or not. Bookings are saved,
anyone with the link can book, and the bill is **$0**.

Two free services, neither of which asks for a card:

- **Render** runs the app. Its free tier has no disk, so nothing is stored there.
- **Neon** holds the bookings. Its free tier says, in its own words, "no credit
  card required".

The database is the only thing that has to outlive the app, so it lives at Neon
and the app is disposable. That is also why this works on a free host at all.

## Step 1 — a free database, about two minutes

1. Go to <https://neon.com>, sign up with GitHub or email. No card.
2. Create a project. Any name, any region near you.
3. It shows you a **connection string**. It looks like:

       postgresql://neondb_owner:abc123@ep-cool-name-12345.ap-southeast-1.aws.neon.tech/neondb?sslmode=require

   Copy it. If Neon offers a **pooled** connection string, prefer that one: the app
   opens a few connections and pooling is what that is for.

That string is a password to your data. Do not paste it into a chat, an issue, or
a screenshot. It goes in one place, in the next step.

Three things worth knowing when you pick the project:

- **Choose a region near the salon.** The app talks to the database on every
  request, so a database in another continent is felt on every page. India is
  closest to Singapore or Mumbai.
- **Use the pooled connection string** if Neon offers both. It ends in
  `-pooler`. The app opens several connections and pooling is what that endpoint
  is for.
- **A booking costs several round trips**, so latency to this database is the
  single biggest factor in how fast booking feels.

**If the string has been shared anywhere** — pasted into a chat, an issue, a
screenshot — rotate it: Neon dashboard, Roles, reset the password. Then update
`DATABASE_URL` on the host and redeploy. It takes a minute and it is the only way
to unshare a password.

## Step 2 — the app, one click

<https://render.com/deploy?repo=https://github.com/neerajdad123-byte/goldenhue-booking>

Sign in with GitHub and let Render read this one repository. It reads `render.yaml`
from the repo, so the plan is already set to **free** and there is nothing to
configure but three values it asks you for:

| Value | What to put |
|---|---|
| `DATABASE_URL` | the Neon connection string from step 1 |
| `ADMIN_EMAIL` | an address for the front desk login. Any address; it is only a label |
| `ADMIN_PASSWORD` | the front-desk password. At least 8 characters. This is what protects your prices and hours |

Apply, and wait a couple of minutes. First boot creates the tables, the example
bookings and your login on the way up.

## Step 3 — use it

You get a URL like `https://goldenhue-booking.onrender.com`.

- The booking page: the URL itself.
- The front desk: add `/admin`, and sign in with the values from step 2.

## The one real catch

Render stops a free service after **15 minutes without traffic**, and the next
visitor waits about a minute while it wakes up. Nothing is lost when that happens
— the bookings are at Neon, not on the host — but the first person after a quiet
spell will see a loading page.

That is the price of free, and it is a fair one while you are showing the thing to
salons. When a salon is actually taking bookings on it, the paid instance removes
it, and so would moving to a host that keeps a process warm.

## After that

**Change the front-desk password**: edit `ADMIN_PASSWORD` in the Render dashboard
and redeploy. The next boot notices and re-hashes it, so the new password works
and the old one stops.

**Custom domain**: a free Render service supports custom domains with a TLS
certificate, from the service's Settings page.

**Backups**: Neon's free tier keeps a short history you can restore from. Export
with `pg_dump "$DATABASE_URL" > backup.sql` if you want a copy of your own.

## If something goes wrong

**"Application failed to respond"** — still booting, or the service crashed on
start. Open the Render logs: the app prints `Could not start: ...` and the reason.

**Bookings disappear** — `DATABASE_URL` is missing or wrong, so it fell back to a
local SQLite file on a host with no disk. Check the log line: it says either
`managed Postgres` or a file path.

**The front desk refuses the password** — `ADMIN_PASSWORD` was changed and the
service has not redeployed yet. Redeploy, or check for a typo.

**"Connection terminated" or TLS errors** — the connection string needs
`?sslmode=require`. Neon includes it; if it was trimmed, add it back.

## Why not Firebase

Firebase would also be free, and its free tier is generous. The reason it is not
the first choice here is that Firestore has no server-side transactions available
without Cloud Functions, and **Cloud Functions require the Blaze plan, which needs
a card**. The booking guard — the thing that stops two people taking the same slot
— is the one part that must run on a server, so it is the part that decides this.

The storage layer is isolated behind `outputs/demo/store.js`, so a Firestore
version is a second implementation of one file rather than a rewrite. The design
for it, including how the guard would work, is written at the bottom of that file.
Worth doing when there is a reason, not to save $0.
