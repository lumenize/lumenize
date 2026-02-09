/**
 * CalculatorClient - Browser client for testing operation nesting
 *
 * Simple client that calls CalculatorDO to demonstrate nested operations
 * from calls.mdx.
 */

import { LumenizeClient, mesh } from '../../../src/index.js';
import type { CalculatorDO } from './calculator-do.js';

export class CalculatorClient extends LumenizeClient {
  // Store results received via handlers
  readonly results: number[] = [];

  /**
   * Calculate using nested operations
   *
   * Demonstrates: add(add(1,10), add(100,1000)) = 1111
   * All nested operations execute in a single round trip.
   */
  calculateNested() {
    this.lmz.call(
      'CALCULATOR_DO',
      'calc-1',
      this.ctn<CalculatorDO>().add(
        this.ctn<CalculatorDO>().add(1, 10),      // Returns 11
        this.ctn<CalculatorDO>().add(100, 1000)   // Returns 1100
      ),  // add(11, 1100) = 1111
      this.ctn().handleResult(this.ctn().$result)
    );
  }

  /**
   * Calculate using chained operations
   *
   * This is a simpler example: multiply(5, add(2, 3)) = 25
   */
  calculateChained() {
    this.lmz.call(
      'CALCULATOR_DO',
      'calc-1',
      this.ctn<CalculatorDO>().multiply(5, this.ctn<CalculatorDO>().add(2, 3)),  // multiply(5, 5) = 25
      this.ctn().handleResult(this.ctn().$result)
    );
  }

  // Handler that receives calculation results
  // Note: This is a local handler called after the remote call completes.
  // It does NOT need @mesh because it's not called by external mesh nodes.
  handleResult(result: number | Error) {
    if (result instanceof Error) {
      console.error('Calculation failed:', result);
      return;
    }
    this.results.push(result);
  }
}
