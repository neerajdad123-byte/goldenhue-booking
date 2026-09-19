# Getting it online, once

After this, the site runs whether your laptop is on or not. Bookings are saved, and
anyone with the link can book.

## What it costs

Render's cheapest instance plus a 1 GB disk: **about $7 + $0.25 a month**. The disk
is the part that must not be skipped.

That is not upselling, it is Render's own documentation: free web services have an
"ephemeral filesystem", and

> any changes to your web service's filesystem (uploaded images, local SQLite
> databases, etc.) are lost every time the service redeploys, restarts, or spins
> down

Free services also spin down after 15 minutes without traffic. A salon's database
would be wiped several times a day. Free is fine for showing someone the design;
it cannot hold bookings.

## Do it

1. **Open this link** — it reads `render.yaml` from the repository, so there is
   nothing to configure by hand:

   <https://render.com/deploy?repo=https://github.com/neerajdad123-byte/goldenhue-booking>

2. **Sign in with GitHub** and let Render read the repository. It needs access to
   this one repo; nothing else.

3. **It shows you the plan**: one web service, one disk, and two values it is
   asking you for:
   - `ADMIN_EMAIL` — the login for the front desk. Any address; it is only a label.
   - `ADMIN_PASSWORD` — the front-desk password. Choose a real one, at least 8
     characters. This is the only thing standing between the internet and your
     prices and hours.

4. **Apply.** It builds and starts on its own. First boot takes a couple of minutes;
   the database, the example bookings and your login are created on the way up.

5. **You get a URL** like `https://goldenhue-booking.onrender.com`. That is the
   booking page. Add `/admin` for the front desk, and sign in with the values from
   step 3.

## After that

**To change the front-desk password**, edit `ADMIN_PASSWORD` in the Render
dashboard and redeploy. The next boot notices the difference and re-hashes it, so
the new password works and the old one stops working. Nothing else is touched.

**Bookings are safe** across restarts, redeploys and crashes, because the database
is on the disk. You can prove it the way the test does: book something, restart the
service from the dashboard, and look again.

**Custom domain**: any paid Render instance supports it, with a TLS certificate,
from the service's Settings page. Point a salon's domain at it and add the salon to
the catalogue.

## If something goes wrong

**"Application failed to respond"** — the service is still booting, or the port is
wrong. The app reads `PORT` from the environment, which Render sets.

**Bookings disappear after a redeploy** — the disk is not mounted, or `DB_FILE`
does not point at it. It must be under `/var/data`, the mount path.

**The front desk says the password is wrong** — `ADMIN_PASSWORD` was set after the
first boot and does not match. Change it in the dashboard and redeploy; the next
boot syncs it.

**The page loads but finding slots fails** — check `/health` first. It reports the
number of appointments the server can see, which tells you whether it is the
database or the network.

## The other option, and why not yet

Vercel plus Firestore would also work, with a managed database and no disk to think
about. The reason it is not done is that swapping SQLite for Firestore means
rewriting the atomic booking guard, and that guard is the thing that stops two
people booking the same slot. It can be written and proven, but only against a real
Firestore, and it is a bigger change than it sounds.

The storage layer is already isolated in `outputs/demo/store.js` with the Firestore
design written at the bottom of the file, so that move is a second implementation of
one module rather than a rewrite of the app. Worth doing when there is a reason:
more than one instance, or a backup story you would rather not think about.
