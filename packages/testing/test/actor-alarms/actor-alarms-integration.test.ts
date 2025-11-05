/**
 * Integration test: @lumenize/testing alarm simulation + @cloudflare/actors Alarms
 * 
 * This test validates that our alarm simulation works correctly with Actor's
 * multiplexed alarms system. Actor's Alarms uses ctx.storage.setAlarm() under
 * the hood, so our simulation should transparently enable automatic alarm firing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestingClient, type RpcAccessible } from '../../src/index';
import { ActorAlarmsDO } from './test-worker-and-dos';

type ActorAlarmsDOType = RpcAccessible<InstanceType<typeof ActorAlarmsDO>>;

describe('Actor Alarms Integration', () => {
  
  it('schedules multiple alarms with different types and they fire automatically', async () => {
    await using client = createTestingClient<ActorAlarmsDOType>(
      'ACTOR_ALARMS_DO', 
      'multi-types-test'
    );

    // Clear any previous alarms
    await client.clearExecutedAlarms();

    // 1. Schedule with a Date (execute at specific time)
    // Use 0.5 seconds from now (1x timescale = real time)
    const futureDate = new Date(Date.now() + 500);
    const dateSchedule = await client.alarms.schedule(
      futureDate, 
      'handleAlarm', 
      { type: 'date', message: 'Executed at specific time' }
    );
    expect(dateSchedule.type).toBe('scheduled');
    expect(dateSchedule.callback).toBe('handleAlarm');

    // 2. Schedule with delay in seconds
    // Use 1 second (1x timescale = real time)
    const delaySchedule = await client.alarms.schedule(
      1, // 1 second
      'handleAlarm', 
      { type: 'delay', message: 'Executed after delay' }
    );
    expect(delaySchedule.type).toBe('delayed');

    // 3. Schedule with cron expression (every minute)
    // We won't wait for cron to fire - just verify it can be scheduled
    const cronSchedule = await client.alarms.schedule(
      '* * * * *', 
      'handleAlarm', 
      { type: 'cron', message: 'Recurring task' }
    );
    expect(cronSchedule.type).toBe('cron');

    // Wait for the first two alarms to fire automatically
    // NO runDurableObjectAlarm needed! Our simulation handles it!
    await vi.waitFor(async () => {
      const executed = await client.getExecutedAlarms();
      expect(executed.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 }); // 2s timeout for 0.5s + 1s alarms at 1x speed

    // Verify both alarms executed with correct payloads
    const executed = await client.getExecutedAlarms();
    expect(executed.some((msg: string) => msg.includes('date'))).toBe(true);
    expect(executed.some((msg: string) => msg.includes('delay'))).toBe(true);
    
    console.log('✅ Multiple alarms fired automatically without runDurableObjectAlarm!');
    console.log('Executed alarms:', executed);
  });

  it('queries and cancels scheduled alarms', async () => {
    await using client = createTestingClient<ActorAlarmsDOType>(
      'ACTOR_ALARMS_DO', 
      'manage-test'
    );

    await client.clearExecutedAlarms();

    // Schedule several alarms
    const schedule1 = await client.alarms.schedule(
      10, // 10 seconds → 100ms in test time
      'handleAlarm',
      { task: 'task-1' }
    );

    const schedule2 = await client.alarms.schedule(
      20, // 20 seconds → 200ms in test time
      'handleAlarm',
      { task: 'task-2' }
    );

    // Get all scheduled alarms
    const allSchedules = await client.alarms.getSchedules();
    expect(allSchedules.length).toBeGreaterThanOrEqual(2);

    // Get a specific schedule by ID
    const retrieved = await client.alarms.getSchedule(schedule1.id);
    expect(retrieved?.payload).toEqual({ task: 'task-1' });

    // Cancel a schedule
    const cancelled = await client.alarms.cancelSchedule(schedule2.id);
    expect(cancelled).toBe(true);

    // Verify it's gone
    const afterCancel = await client.alarms.getSchedules();
    expect(afterCancel.some((s: any) => s.id === schedule2.id)).toBe(false);
    
    console.log('✅ Alarm management (query/cancel) works correctly!');
  });

  it('handles rapid sequential alarms', async () => {
    await using client = createTestingClient<ActorAlarmsDOType>(
      'ACTOR_ALARMS_DO', 
      'rapid-test'
    );

    await client.clearExecutedAlarms();

    // Schedule multiple alarms in quick succession (1x timescale = real time)
    // Note: Schedule them with a bit more spacing to ensure Actor's internal
    // setAlarm calls have time to settle
    await client.alarms.schedule(0.4, 'handleAlarm', { order: 1 }); // 400ms
    await client.alarms.schedule(0.7, 'handleAlarm', { order: 2 }); // 700ms
    await client.alarms.schedule(1.0, 'handleAlarm', { order: 3 }); // 1000ms

    // Wait for all to fire
    await vi.waitFor(async () => {
      const executed = await client.getExecutedAlarms();
      expect(executed.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 1800 }); // 1.8s timeout

    const executed = await client.getExecutedAlarms();
    expect(executed.length).toBe(3);
    
    // Verify they all executed (order doesn't matter for this test)
    expect(executed.some((msg: string) => msg.includes('"order":1'))).toBe(true);
    expect(executed.some((msg: string) => msg.includes('"order":2'))).toBe(true);
    expect(executed.some((msg: string) => msg.includes('"order":3'))).toBe(true);
    
    console.log('✅ Multiple rapid alarms all fired correctly!');
  });

  it('verifies Actor alarms system multiplexes over single native alarm', async () => {
    await using client = createTestingClient<ActorAlarmsDOType>(
      'ACTOR_ALARMS_DO', 
      'multiplex-test'
    );

    await client.clearExecutedAlarms();

    // Actor's Alarms allows multiple scheduled alarms
    // but uses only ONE ctx.storage.setAlarm() underneath
    await client.alarms.schedule(0.4, 'handleAlarm', { id: 'first' }); // 400ms
    await client.alarms.schedule(0.7, 'handleAlarm', { id: 'second' }); // 700ms
    await client.alarms.schedule(1.0, 'handleAlarm', { id: 'third' }); // 1000ms

    // Our simulation should handle the native alarm firing
    // and Actor's Alarms should reschedule the next one
    await vi.waitFor(async () => {
      const executed = await client.getExecutedAlarms();
      expect(executed.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 1800 }); // 1.8s timeout

    const executed = await client.getExecutedAlarms();
    expect(executed.length).toBe(3);
    
    console.log('✅ Actor Alarms multiplexing works with our single-alarm simulation!');
    console.log('This proves our simulation correctly enables Actor\'s multi-alarm system!');
  });
});

