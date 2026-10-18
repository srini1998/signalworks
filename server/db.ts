import "dotenv/config";
import pg from "pg";

const host = "127.0.0.1";
const port = Number(process.env.SW_PG_PORT ?? 54563);
const database = "signalworks";
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (see .env.example)`);
  return v;
};

/** Pools per role. The API never holds the owner credential; only scripts/migrate does. */
export const ownerPool = () => new pg.Pool({ host, port, database, user: "sw_owner", password: need("SW_OWNER_PASSWORD"), max: 2 });
export const appPool = new pg.Pool({ host, port, database, user: "sw_app", password: need("SW_APP_PASSWORD"), max: 10 });
export const workerPool = new pg.Pool({ host, port, database, user: "sw_worker", password: need("SW_WORKER_PASSWORD"), max: 6 });

export type Tx = pg.PoolClient;

/** Run `fn` in a transaction with the session user's identity bound for RLS. */
export async function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Unauthenticated app-role access (only the SECURITY DEFINER auth functions are callable). */
export async function anon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Worker access scoped to exactly one workspace. */
export async function inWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await workerPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
