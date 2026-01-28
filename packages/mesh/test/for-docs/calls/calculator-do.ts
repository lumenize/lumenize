/**
 * CalculatorDO - Simple calculator for demonstrating operation nesting
 *
 * Example from calls.mdx showing how nested operations execute
 * in a single round trip with results feeding into outer operations.
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

export class CalculatorDO extends LumenizeDO<Env> {
  // Require authentication for all mesh calls
  onBeforeCall(): void {
    super.onBeforeCall();
    if (!this.lmz.callContext.originAuth?.userId) {
      throw new Error('Authentication required');
    }
  }

  @mesh()
  add(a: number, b: number): number {
    return a + b;
  }

  @mesh()
  multiply(a: number, b: number): number {
    return a * b;
  }

  @mesh()
  subtract(a: number, b: number): number {
    return a - b;
  }
}
