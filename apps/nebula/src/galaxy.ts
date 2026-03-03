/**
 * Galaxy — singleton per galaxy (e.g., instanceName = "acme.app")
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireAdmin } from './nebula-do.js';

export class Galaxy extends NebulaDO {
  @mesh(requireAdmin)
  setGalaxyConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getGalaxyConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
  }
}
