import type { ModuleDef } from "./types.ts";
import alertscenario from "./alertscenario.ts";
import metriccontract from "./metriccontract.ts";
import routereplay from "./routereplay.ts";
import serieswatch from "./serieswatch.ts";
import dashboardreplay from "./dashboardreplay.ts";
import filterproof from "./filterproof/index.ts";

export const MODULE_DEFS: ModuleDef[] = [alertscenario, metriccontract, routereplay, serieswatch, dashboardreplay, filterproof];

export function getModule(id: string): ModuleDef {
  const m = MODULE_DEFS.find((d) => d.id === id);
  if (!m) throw new Error(`module ${id} is not implemented`);
  return m;
}
