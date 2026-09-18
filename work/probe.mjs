import { PGlite } from "@electric-sql/pglite";

const db = await new PGlite();
await db.exec(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
await db.exec(`
  CREATE TABLE appointment (
    id serial primary key,
    staff_id int not null,
    starts_at timestamptz not null,
    buffer_until timestamptz not null,
    status text not null default 'booked'
  );
  ALTER TABLE appointment ADD CONSTRAINT no_double_booking
    EXCLUDE USING gist (
      staff_id WITH =,
      tstzrange(starts_at, buffer_until, '[)') WITH &&
    ) WHERE (status IN ('pending','booked','confirmed'));
`);

const ins = (staff, start, end) =>
  db.query("insert into appointment (staff_id, starts_at, buffer_until) values ($1,$2,$3)", [staff, start, end]);

await ins(5, "2026-09-18T10:00:00+05:30", "2026-09-18T12:00:00+05:30");

// concurrent duplicate -> must be rejected
const results = await Promise.allSettled(
  Array.from({ length: 20 }, () => ins(5, "2026-09-18T10:00:00+05:30", "2026-09-18T12:00:00+05:30"))
);
const ok = results.filter(r => r.status === "fulfilled").length;
const rejected = results.filter(r => r.status === "rejected");
console.log("ins5_ok", ok, "rejected", rejected.length, "code", rejected[0]?.reason?.code);

// back-to-back at 12:00 must be allowed
await ins(5, "2026-09-18T12:00:00+05:30", "2026-09-18T12:30:00+05:30");
console.log("back_to_back ok");

// overlap 11:59 must be rejected
const bad = await ins(5, "2026-09-18T11:59:00+05:30", "2026-09-18T12:05:00+05:30").then(() => "LEAK").catch(e => e.code);
console.log("overlap_11_59:", bad);

const { rows } = await db.query("select count(*)::int c from appointment");
console.log("total_rows", rows[0].c);
