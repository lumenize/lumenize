/**
 * ResourceHistory — a tenant-scoped helper DO used as the canonical scope-isolation
 * test fixture (see tasks/nebula-do-scope-isolation.md). Scope binding is enforced
 * structurally by the base class; @see NebulaDO.
 *
 * NOT a home for resource history. Resource history (old snapshots) is stored in R2,
 * not in per-resource DOs — see tasks/on-hold/nebula-resource-history-r2.md. This class
 * has no production caller; it exists only to exercise NebulaDO's tenant isolation.
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO } from './nebula-do';

export class ResourceHistory extends NebulaDO {
  @mesh()
  getHistory(): string {
    return `History for resource ${this.lmz.instanceName}`;
  }
}
