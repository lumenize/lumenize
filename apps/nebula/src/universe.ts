/**
 * Universe — singleton per universe (e.g., instanceName = "acme")
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireAdmin } from './nebula-do.js';

export class Universe extends NebulaDO {
  @mesh(requireAdmin)
  setUniverseConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getUniverseConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
  }
}
