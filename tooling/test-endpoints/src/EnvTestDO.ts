/**
 * EnvTestDO - Test environment variable refresh behavior
 * 
 * Tests whether environment variables are refreshed when:
 * 1. Constructor runs after hibernation
 * 2. Constructor runs after hard reset (.abort())
 * 3. During active Worker fetch (no DO involvement)
 * 
 * Routes:
 * - GET /env-test/{instance}/info - Show current env values and constructor history
 * - POST /env-test/{instance}/reset - Force hard reset via ctx.abort()
 * - POST /env-test/{instance}/clear - Clear storage for fresh start
 */

import { DurableObject } from 'cloudflare:workers';

interface ConstructorRun {
  timestamp: number;
  debugValue: string;
  runNumber: number;
}

export class EnvTestDO extends DurableObject<Env> {
  #debugFromConstructor: string;
  #constructorTimestamp: number;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    this.#constructorTimestamp = Date.now();
    this.#debugFromConstructor = env.DEBUG || 'NOT_SET';
    
    // Track constructor runs in storage (synchronous!)
    ctx.blockConcurrencyWhile(() => {
      const runs = ctx.storage.kv.get<ConstructorRun[]>('constructorRuns') ?? [];
      const runNumber = runs.length + 1;
      
      const newRun: ConstructorRun = {
        timestamp: this.#constructorTimestamp,
        debugValue: this.#debugFromConstructor,
        runNumber
      };
      
      runs.push(newRun);
      ctx.storage.kv.put('constructorRuns', runs);
      
      console.log('EnvTestDO constructor run', {
        runNumber,
        debugValue: this.#debugFromConstructor,
        timestamp: this.#constructorTimestamp,
        instanceId: ctx.id.toString()
      });
    });
  }
  
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Extract endpoint from path (last segment)
    const segments = path.split('/').filter(Boolean);
    const endpoint = segments[segments.length - 1];
    
    switch (endpoint) {
      case 'info':
        return this.handleInfo();
      
      case 'reset':
        return this.handleReset();
      
      case 'clear':
        return this.handleClear();
      
      default:
        return new Response(JSON.stringify({
          error: 'Unknown endpoint',
          availableEndpoints: ['info', 'reset', 'clear']
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
    }
  }
  
  /**
   * Show current env values and constructor history
   */
  private handleInfo(): Response {
    const constructorRuns = this.ctx.storage.kv.get<ConstructorRun[]>('constructorRuns') ?? [];
    const now = Date.now();
    const msSinceConstructor = now - this.#constructorTimestamp;
    
    // Check hibernation eligibility
    const isHibernatable = !this.ctx.storage.kv.get('nonHibernatableState');
    
    const info = {
      // Current values
      current: {
        debugFromConstructor: this.#debugFromConstructor,
        debugFromEnvNow: this.env.DEBUG || 'NOT_SET',
        timestamp: now,
        msSinceConstructor,
        secondsSinceConstructor: Math.floor(msSinceConstructor / 1000)
      },
      
      // Constructor history from storage
      constructorHistory: {
        totalRuns: constructorRuns.length,
        runs: constructorRuns.map(run => ({
          ...run,
          debugValueChanged: run.runNumber > 1 && 
            run.debugValue !== constructorRuns[run.runNumber - 2].debugValue
        }))
      },
      
      // Hibernation info
      hibernation: {
        eligible: isHibernatable,
        secondsSinceConstructor: Math.floor(msSinceConstructor / 1000),
        note: 'Hibernation can occur after 10+ seconds of inactivity if eligible'
      },
      
      // Instance info
      instance: {
        id: this.ctx.id.toString(),
        name: this.ctx.id.name
      }
    };
    
    return new Response(JSON.stringify(info, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  /**
   * Force a hard reset by calling ctx.abort()
   * This will cause the DO to be evicted and constructor to run again
   */
  private handleReset(): Response {
    const currentRuns = this.ctx.storage.kv.get<ConstructorRun[]>('constructorRuns') ?? [];
    
    // Record that we're about to reset
    console.log('EnvTestDO: Forcing hard reset via ctx.abort()', {
      currentRunCount: currentRuns.length,
      lastDebugValue: currentRuns[currentRuns.length - 1]?.debugValue,
      instanceId: this.ctx.id.toString()
    });
    
    // Return response before aborting
    const response = new Response(JSON.stringify({
      message: 'Hard reset triggered via ctx.abort()',
      note: 'DO will be evicted and constructor will run on next request',
      currentRunCount: currentRuns.length,
      nextExpectedRun: currentRuns.length + 1
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Schedule abort after response is sent
    this.ctx.waitUntil((async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      this.ctx.abort();
    })());
    
    return response;
  }
  
  /**
   * Clear all storage for a fresh start
   */
  private handleClear(): Response {
    this.ctx.storage.sql.exec('DELETE FROM _cf_KV');
    
    return new Response(JSON.stringify({
      message: 'Storage cleared',
      note: 'Constructor history reset. Instance will still exist until evicted.'
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

interface Env {
  DEBUG?: string;
}

