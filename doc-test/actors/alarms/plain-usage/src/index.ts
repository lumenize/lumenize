import { Storage } from "@cloudflare/actors/storage";
import { Alarms, type Schedule } from "@cloudflare/actors/alarms";
import { DurableObject } from "cloudflare:workers";
import { lumenizeRpcDO } from "@lumenize/rpc";
import { routeDORequest } from "@lumenize/utils";

class _AlarmDO extends DurableObject<Env> {
  storage: Storage;
  alarms: Alarms<this>;
  executedAlarms: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new Storage(ctx.storage);
    this.alarms = new Alarms(ctx, this);
  }

  // Required boilerplate: delegate to Alarms instance
  async alarm() {
    await this.alarms.alarm();
  }

  // Callback for alarms - gets called when an alarm fires
  async handleAlarm(payload: any, schedule: Schedule) {
    const message = `Alarm ${schedule.id} fired: ${JSON.stringify(payload)}`;
    this.executedAlarms.push(message);
  }

  // Method to get executed alarms (for testing)
  getExecutedAlarms(): string[] {
    return this.executedAlarms;
  }
}

// Wrap with RPC support so we can demo in doc-test.
// You can just export the class above directly instead:
//   `export const AlarmDO extends DurableObject<Env>{...}`
export const AlarmDO = lumenizeRpcDO(_AlarmDO);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route RPC requests to enable demo in doc-test
    const response = await routeDORequest(request, env, { prefix: '__rpc' });
    if (response) return response;
    
    // Fallback for non-RPC requests
    return new Response('Alarms doc-test worker', { status: 404 });
  },
};

