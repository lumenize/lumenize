/**
 * Alarm simulation for Cloudflare Durable Objects in test environments.
 * 
 * This module provides transparent mocking of ctx.storage alarm methods to enable
 * automatic alarm firing in tests without manual runDurableObjectAlarm() calls.
 * 
 * Key features:
 * - Matches Cloudflare alarm behavior (single alarm, setAlarm overwrites)
 * - Automatic retry with exponential backoff (100x faster for tests)
 * - Uses setTimeout to trigger alarm() at the right time
 * - Handles the frozen clock issue in Durable Objects
 */

/**
 * Configuration for alarm simulation behavior
 */
export interface AlarmSimulationConfig {
  /**
   * Time scale factor for alarm delays and retries.
   * 
   * @default 100 (100x faster: 2s becomes 20ms, 4s becomes 40ms, etc.)
   * 
   * Set to 1 for production timing (not recommended for tests).
   */
  timeScale?: number;
  
  /**
   * Maximum number of retries when alarm() throws
   * 
   * @default 6 (matches Cloudflare)
   */
  maxRetries?: number;
  
  /**
   * Enable debug logging for alarm simulation
   * 
   * @default false
   */
  debug?: boolean;
}

/**
 * Default configuration matching Cloudflare behavior (but 100x faster)
 */
const DEFAULT_CONFIG: Required<AlarmSimulationConfig> = {
  timeScale: 100,
  maxRetries: 6,
  debug: false,
};

/**
 * State for a single alarm simulation
 */
interface AlarmState {
  scheduledTime: number | null;
  timeoutId: any | null;
  isRunning: boolean;
}

/**
 * Enable alarm simulation for a Durable Object instance.
 * 
 * This function transparently mocks ctx.storage.setAlarm/getAlarm/deleteAlarm
 * to enable automatic alarm firing in tests.
 * 
 * **How it works**:
 * 1. Saves original alarm methods
 * 2. Replaces them with simulation versions
 * 3. Uses setTimeout to trigger alarm() at scheduled time
 * 4. Handles retries with exponential backoff (100x faster)
 * 5. Matches Cloudflare behavior: new setAlarm overwrites pending alarm
 * 
 * **Called by**: `instrumentDOProject` during DO class wrapping
 * 
 * @param doInstance - The Durable Object instance to instrument
 * @param config - Optional configuration for simulation behavior
 * 
 * @example
 * ```typescript
 * const doInstance = new MyDO(ctx, env);
 * enableAlarmSimulation(doInstance);
 * 
 * // Now alarms fire automatically!
 * doInstance.ctx.storage.setAlarm(Date.now() + 1000);
 * // ... alarm() will be called after ~10ms (100x faster)
 * ```
 */
export function enableAlarmSimulation(
  doInstance: any,
  config: AlarmSimulationConfig = {}
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  // Check if DO has an alarm() method
  if (typeof doInstance.alarm !== 'function') {
    if (cfg.debug) {
      console.log('[AlarmSim] DO has no alarm() method, skipping simulation');
    }
    return;
  }
  
  // Alarm state for this DO instance
  const alarmState: AlarmState = {
    scheduledTime: null,
    timeoutId: null,
    isRunning: false,
  };
  
  // Store ctx for waitUntil usage
  const ctx = doInstance.ctx;
  
  // Save original methods
  const originalSetAlarm = ctx.storage.setAlarm.bind(ctx.storage);
  const originalGetAlarm = ctx.storage.getAlarm.bind(ctx.storage);
  const originalDeleteAlarm = ctx.storage.deleteAlarm.bind(ctx.storage);
  
  if (cfg.debug) {
    console.log('[AlarmSim] Enabling alarm simulation for DO');
  }
  
  /**
   * Fire the alarm with automatic retry on failure
   */
  async function fireAlarmWithRetries(retryCount: number = 0): Promise<void> {
    if (alarmState.isRunning) {
      if (cfg.debug) {
        console.log('[AlarmSim] Alarm already running, skipping duplicate fire');
      }
      return;
    }
    
    alarmState.isRunning = true;
    
    try {
      if (cfg.debug) {
        console.log(`[AlarmSim] Firing alarm (retry ${retryCount}/${cfg.maxRetries})`);
      }
      
      // Call alarm() with no parameters (per Cloudflare API spec)
      await doInstance.alarm();
      
      // Success - clear alarm state
      if (cfg.debug) {
        console.log('[AlarmSim] Alarm completed successfully');
      }
      
      alarmState.scheduledTime = null;
      alarmState.timeoutId = null;
      alarmState.isRunning = false;
      
      // NOTE: We do NOT call originalDeleteAlarm here
      // Our simulation completely replaces the alarm system
      
    } catch (error: any) {
      alarmState.isRunning = false;
      
      if (retryCount < cfg.maxRetries) {
        // Cloudflare retry delays: 2s, 4s, 8s, 16s, 32s, 64s
        // Test defaults: 20ms, 40ms, 80ms, 160ms, 320ms, 640ms
        const cloudflareDelay = Math.pow(2, retryCount + 1) * 1000;
        const testDelay = cloudflareDelay / cfg.timeScale;
        
        if (cfg.debug || retryCount > 0) {
          console.log(
            `[AlarmSim] Alarm failed (retry ${retryCount + 1}/${cfg.maxRetries}), ` +
            `retrying in ${testDelay}ms: ${error.message || error}`
          );
        }
        
        alarmState.timeoutId = setTimeout(
          () => fireAlarmWithRetries(retryCount + 1),
          testDelay
        );
      } else {
        console.error(
          `[AlarmSim] Alarm failed after ${cfg.maxRetries} retries, giving up:`,
          error
        );
        
        // Cloudflare gives up after max retries - clear alarm
        alarmState.scheduledTime = null;
        alarmState.timeoutId = null;
      }
    }
  }
  
  /**
   * Mock setAlarm - schedules alarm to fire via setTimeout
   */
  (doInstance.ctx.storage as any).setAlarm = (scheduledTimeMs: number): void => {
    // Clear any existing alarm (Cloudflare allows only one alarm)
    if (alarmState.timeoutId) {
      clearTimeout(alarmState.timeoutId);
      if (cfg.debug) {
        console.log('[AlarmSim] Cleared existing alarm (new setAlarm overwrites)');
      }
    }
    
    // Calculate delay from now
    const now = Date.now();
    const delay = scheduledTimeMs - now;
    
    // Store scheduled time
    alarmState.scheduledTime = scheduledTimeMs;
    
    if (cfg.debug) {
      console.log(
        `[AlarmSim] setAlarm(${scheduledTimeMs}): ` +
        `scheduling for ${Math.max(0, delay)}ms from now ` +
        `(${Math.max(0, delay / cfg.timeScale)}ms in test time)`
      );
    }
    
    // Schedule the alarm
    const fireAlarm = async () => {
      await fireAlarmWithRetries(0);
    };
    
    if (delay > 0) {
      // Future alarm - use scaled delay
      const testDelay = delay / cfg.timeScale;
      alarmState.timeoutId = setTimeout(() => {
        // Use waitUntil to keep DO context alive while alarm executes
        ctx.waitUntil(fireAlarm());
      }, testDelay);
    } else {
      // Immediate alarm (scheduled in past or at now)
      alarmState.timeoutId = setTimeout(() => {
        ctx.waitUntil(fireAlarm());
      }, 0);
    }
    
    // NOTE: We do NOT call originalSetAlarm here!
    // Calling it would invoke Cloudflare's real alarm system which conflicts with our simulation.
    // Our simulation completely replaces the alarm system for testing.
  };
  
  /**
   * Mock getAlarm - returns scheduled time from our state
   */
  (doInstance.ctx.storage as any).getAlarm = (): number | null => {
    return alarmState.scheduledTime;
  };
  
  /**
   * Mock deleteAlarm - cancels scheduled alarm
   */
  (doInstance.ctx.storage as any).deleteAlarm = (): void => {
    if (alarmState.timeoutId) {
      clearTimeout(alarmState.timeoutId);
      alarmState.timeoutId = null;
      
      if (cfg.debug) {
        console.log('[AlarmSim] deleteAlarm() - cancelled pending alarm');
      }
    }
    
    alarmState.scheduledTime = null;
    
    // NOTE: We do NOT call originalDeleteAlarm here
    // Our simulation completely replaces the alarm system
  };
  
  if (cfg.debug) {
    console.log('[AlarmSim] Alarm simulation enabled successfully');
  }
}

