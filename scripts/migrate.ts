import { readFileSync, readdirSync } from "node:fs";
import { ownerPool } from "../server/db.ts";

const pool = ownerPool();
await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
for (const name of readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort()) {
  const done = await pool.query("select 1 from schema_migrations where name = $1", [name]);
  if (done.rowCount) continue;
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(readFileSync(`db/migrations/${name}`, "utf8"));
    await c.query("insert into schema_migrations(name) values ($1)", [name]);
    await c.query("commit");
    console.log(`applied ${name}`);
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
// Role passwords come from .env; never stored in migrations.
await pool.query(`alter role sw_app password '${process.env.SW_APP_PASSWORD!.replace(/'/g, "''")}'`);
await pool.query(`alter role sw_worker password '${process.env.SW_WORKER_PASSWORD!.replace(/'/g, "''")}'`);
await pool.end();
console.log("migrations complete");
