/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireAdmin } from './nebula-do.js';

export class Star extends NebulaDO {
  @mesh(requireAdmin)
  setStarConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
  }

  @mesh()
  whoAmI(): string {
    return `You are ${this.lmz.callContext.originAuth!.sub}`;
  }
}
