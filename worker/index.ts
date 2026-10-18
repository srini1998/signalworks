import { randomUUID } from "node:crypto";
import { workerPool } from "../server/db.ts";
import { claim, execute, withStackLock } from "./runtime.ts";

const workerId = `worker-${randomUUID().slice(0, 8)}`;
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
console.log(JSON.stringify({ ts: new Date().toISOString(), event: "worker.started", worker_id: workerId }));
while (!stopping) {
  try {
    const worked = await withStackLock(async () => {
      const run = await claim(workerId);
      if (run) await execute(workerId, run);
      return !!run;
    });
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: "worker.error", worker_id: workerId, message: (e as Error).message }));
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await workerPool.end();
