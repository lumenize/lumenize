// Startup A/B arm WITH: imports exactly what a collapsed Galaxy would.
import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, getWorkspace, type WorkspaceOptions, WorkspaceProxy, withWorkspace } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
export { WorkspaceProxy };
class B extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({ container: () => this, workspace: { binding: "VfsBuildDO", id: "x" } });
}
function opts(self: InstanceType<typeof B>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return { storage: ctx.storage as unknown as DurableObjectStorageLike, backends: [self.backend] };
}
export class StartupDO extends withWorkspace(B, opts) {
  override async fetch(): Promise<Response> { return Response.json({ ok: typeof getWorkspace }); }
}
export default { async fetch(): Promise<Response> { return new Response("with"); } } satisfies ExportedHandler<Env>;
