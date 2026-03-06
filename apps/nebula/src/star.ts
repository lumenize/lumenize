/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access.
 * The tree is created in onStart (synchronous SQL) and exposed via
 * a single @mesh() entry point — DagTree handles per-operation auth internally.
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO } from './nebula-do';
import { DagTree } from './dag-tree';

export class Star extends NebulaDO {
  #dagTree!: DagTree

  onStart() {
    this.#dagTree = new DagTree(
      this.ctx,
      () => this.lmz.callContext,
      () => this.#onChanged(),
    )
  }

  /**
   * Single @mesh() entry point for the entire DagTree API.
   * OCAN executor checks @mesh() only on this method;
   * subsequent operations (e.g., .createNode(), .getState()) traverse freely.
   * DagTree handles per-operation auth internally via #requirePermission.
   */
  @mesh()
  dagTree(): DagTree {
    return this.#dagTree
  }

  #onChanged() {
    // Phase 3.1: placeholder — tests verify this callback fires on mutations
    // Phase 5: subscription fan-out via lmz.call() through NebulaClientGateway
  }
}
