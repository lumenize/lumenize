/**
 * RemoteDO - Target for remote calls
 * 
 * Provides a simple echo() method that both Workers RPC
 * and @lumenize/call can invoke.
 */

import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Required for @lumenize/call support

export class RemoteDO extends LumenizeBase<Env> {
  echo(value: string): string {
    // Do a tiny bit of work
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += i;
    }
    return `echo: ${value}`;
  }
}

