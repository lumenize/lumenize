// Startup A/B arm SHELL: imports exactly what apps/nebula's DevStudio imports TODAY
// (dev-studio.ts:31-32), so the swap's NET delta is computer-arm minus this one.
import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
export class StartupDO extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return Response.json({ ok: [typeof Workspace, typeof WorkspaceFileSystem, typeof createGit].join(",") });
  }
}
export default { async fetch(): Promise<Response> { return new Response("shell"); } } satisfies ExportedHandler<Env>;
