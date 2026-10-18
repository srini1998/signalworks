// Seeds the fixture catalog (public manifests + private faults) and two fictional local users,
// each owning one workspace. Passwords are generated and written to .local/demo-users.json
// (gitignored); they are never printed in logs or committed. Idempotent.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ownerPool } from "../server/db.ts";
import { hashPassword } from "../server/auth.ts";
import { MODULE_DEFS } from "../modules/registry.ts";
import { sha256 } from "../agent/schemas.ts";

const pool = ownerPool();
for (const m of MODULE_DEFS) {
  for (const f of m.fixtures) {
    const r = await pool.query(
      `insert into fixture_versions (module, name, version, manifest, content_hash) values ($1,$2,$3,$4,$5)
       on conflict (module, name, version) do update set manifest = excluded.manifest, content_hash = excluded.content_hash returning id`,
      [m.id, f.name, f.version, JSON.stringify({ title: f.title, ...f.manifest }), sha256(f.manifest)]);
    if (f.fault) await pool.query("insert into private_faults values ($1, $2) on conflict (fixture_version_id) do update set fault = excluded.fault", [r.rows[0].id, JSON.stringify(f.fault)]);
  }
}

mkdirSync(".local", { recursive: true });
const credsPath = ".local/demo-users.json";
const creds: Record<string, string> = existsSync(credsPath) ? JSON.parse(readFileSync(credsPath, "utf8")) : {};
const people = [
  { email: "maya@signalworks.local", name: "Maya (fictional SRE)", workspace: "Payments platform" },
  { email: "omar@signalworks.local", name: "Omar (fictional SRE)", workspace: "Search infrastructure" },
];
for (const p of people) {
  creds[p.email] ??= randomBytes(12).toString("base64url");
  const u = await pool.query(
    `insert into users (email, name, password_hash) values ($1,$2,$3)
     on conflict (email) do update set name = excluded.name returning id`, [p.email, p.name, hashPassword(creds[p.email])]);
  const userId = u.rows[0].id;
  const existing = await pool.query("select w.id from workspaces w join memberships m on m.workspace_id = w.id where m.user_id = $1 and w.name = $2", [userId, p.workspace]);
  let ws = existing.rows[0]?.id;
  if (!ws) {
    ws = (await pool.query("insert into workspaces (name) values ($1) returning id", [p.workspace])).rows[0].id;
    await pool.query("insert into memberships values ($1, $2, 'owner')", [ws, userId]);
  }
  for (const m of MODULE_DEFS) {
    const has = await pool.query("select 1 from projects where workspace_id = $1 and module = $2", [ws, m.id]);
    if (!has.rowCount)
      await pool.query("insert into projects (workspace_id, module, name, contract, contract_hash, created_by) values ($1,$2,$3,$4,$5,$6)",
        [ws, m.id, `${m.title} contract`, JSON.stringify(m.defaultContract), sha256(m.defaultContract), userId]);
  }
}
writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
await pool.end();
console.log(`seeded ${MODULE_DEFS.reduce((n, m) => n + m.fixtures.length, 0)} fixtures and ${people.length} fictional users (passwords in ${credsPath})`);
