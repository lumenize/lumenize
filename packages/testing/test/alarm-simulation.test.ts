import { describe, it, expect, vi } from 'vitest';
import { createTestingClient, type RpcAccessible } from '../src/index';
import { TestDO } from './test-do';

type TestDOType = RpcAccessible<InstanceType<typeof TestDO>>;

describe('Alarm Simulation', () => {
  
  it('alarms fire automatically without runDurableObjectAlarm', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'auto-alarm');
    
    // Schedule an alarm for 3000ms from now (will fire in ~30ms due to 100x speed)
    await client.scheduleAlarm(3000, { message: 'test automatic alarm' });
    
    // Check initial state (we have time since alarm is 30ms away)
    const stateBefore = await client.getAlarmState();
    expect(stateBefore.firedCount).toBe(0);
    expect(stateBefore.scheduledTime).not.toBeNull();
    
    // Wait for alarm to fire automatically (no runDurableObjectAlarm needed!)
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(1);
    }, { timeout: 150 }); // Give it 150ms max
    
    // Verify alarm executed with correct payload
    const stateAfter = await client.getAlarmState();
    expect(stateAfter.firedCount).toBe(1);
    expect(stateAfter.lastPayload).toEqual({ message: 'test automatic alarm' });
  });
  
  it('handles alarm cancellation', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'cancel-alarm');
    
    // Schedule an alarm for 1000ms (10ms in test time)
    await client.scheduleAlarm(1000, { message: 'will be cancelled' });
    
    // Verify it's scheduled
    const stateScheduled = await client.getAlarmState();
    expect(stateScheduled.scheduledTime).not.toBeNull();
    
    // Cancel it via deleteAlarm immediately
    await client.ctx.storage.deleteAlarm();
    
    // Verify it's cancelled
    const stateCancelled = await client.getAlarmState();
    expect(stateCancelled.scheduledTime).toBeNull();
    
    // Wait a bit to ensure it doesn't fire
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Alarm should NOT have fired
    const stateFinal = await client.getAlarmState();
    expect(stateFinal.firedCount).toBe(0);
  });
  
  it('new setAlarm overwrites pending alarm', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'overwrite-alarm');
    
    // Schedule first alarm
    await client.scheduleAlarm(200, { message: 'first alarm' });
    
    // Immediately schedule second alarm (should overwrite first)
    await client.scheduleAlarm(50, { message: 'second alarm' });
    
    // Wait for alarm to fire
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(1);
    }, { timeout: 150 });
    
    // Only the second alarm should have fired
    const stateAfter = await client.getAlarmState();
    expect(stateAfter.firedCount).toBe(1);
    expect(stateAfter.lastPayload).toEqual({ message: 'second alarm' });
  });
  
  it('handles very short delays (immediate alarms)', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'immediate-alarm');
    
    // Schedule alarm in the past (should fire immediately)
    await client.scheduleAlarm(0, { message: 'immediate' });
    
    // Wait for it to fire
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(1);
    }, { timeout: 50 });
    
    const stateAfter = await client.getAlarmState();
    expect(stateAfter.lastPayload).toEqual({ message: 'immediate' });
  });
  
  it('handles multiple sequential alarms', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'sequential-alarms');
    
    // Schedule and wait for first alarm
    await client.scheduleAlarm(50, { message: 'first' });
    
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(1);
    }, { timeout: 100 });
    
    // Schedule and wait for second alarm
    await client.scheduleAlarm(50, { message: 'second' });
    
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(2);
    }, { timeout: 100 });
    
    // Verify both executed
    const stateAfter = await client.getAlarmState();
    expect(stateAfter.firedCount).toBe(2);
    expect(stateAfter.lastPayload).toEqual({ message: 'second' });
  });
  
  it('getAlarm returns scheduled time then null after firing', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'getalarm-test');
    
    // Schedule alarm for 1000ms (10ms in test time)
    await client.scheduleAlarm(1000, { message: 'test' });
    
    // getAlarm should return a timestamp immediately
    const scheduledTime = await client.ctx.storage.getAlarm();
    expect(scheduledTime).not.toBeNull();
    expect(typeof scheduledTime).toBe('number');
    
    // Wait for alarm to fire
    await vi.waitFor(async () => {
      const state = await client.getAlarmState();
      expect(state.firedCount).toBe(1);
    }, { timeout: 100 });
    
    // getAlarm should now return null (alarm cleared after execution)
    const clearedTime = await client.ctx.storage.getAlarm();
    expect(clearedTime).toBeNull();
  });
});

