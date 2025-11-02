import { Actor } from "@cloudflare/actors";
import { type Schedule } from "@cloudflare/actors/alarms";
import { lumenizeRpcDO } from "@lumenize/rpc";
import { routeDORequest } from "@lumenize/utils";

class _AlarmDO extends Actor<Env> {
  executedAlarms: string[] = [];

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
//   `export const AlarmDO extends Actor<Env>{...}`
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

