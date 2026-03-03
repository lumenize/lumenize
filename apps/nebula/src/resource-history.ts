/**
 * ResourceHistory — UUID-named DO locked to the creating active scope
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO } from './nebula-do.js';

export class ResourceHistory extends NebulaDO {
  @mesh()
  getHistory(): string {
    return `History for resource ${this.lmz.instanceName}`;
  }
}
