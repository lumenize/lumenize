/**
 * Universe — singleton per universe (e.g., instanceName = "acme")
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireDominionHere } from './nebula-do';

export class Universe extends NebulaDO {
  @mesh(requireDominionHere) // a descendant's member is refused: dominion never flows up
  setUniverseConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh() // open to a descendant's member: shared universe config, read-only
  getUniverseConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }
}
