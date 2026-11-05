// Startup A/B arm WITHOUT: same DO shape, zero @cloudflare/computer in the import graph.
import { DurableObject } from "cloudflare:workers";
export class StartupDO extends DurableObject<Env> {
  override async fetch(): Promise<Response> { return Response.json({ ok: "baseline" }); }
}
export default { async fetch(): Promise<Response> { return new Response("without"); } } satisfies ExportedHandler<Env>;
