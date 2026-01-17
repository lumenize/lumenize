// Import NADIS packages to register services
import '@lumenize/core';
import '@lumenize/alarms';

import { LumenizeDO } from '../src/lumenize-do';
import { LumenizeWorker } from '../src/lumenize-worker';
import type { CallEnvelope } from '../src/lmz-api';
import type { Schedule } from '@lumenize/alarms';
import { getOperationChain } from '../src/ocan/index.js';
import { preprocess } from '@lumenize/structured-clone';

// Export documentation example DOs
export { UsersDO, NotificationsDO } from './for-docs/basic-usage.test';

// Export test DO for NadisPlugin tests
export { NadisPluginTestDO } from './nadis-plugin-test-do';

export class TestDO extends LumenizeDO<Env> {
  executedAlarms: Array<{ payload: any; schedule: Schedule }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations in constructor (recommended pattern)
    this.#initTable();
  }

  // Required: delegate to Alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }

  // Migration: Create users table
  #initTable() {
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        age INTEGER
      )
    `;
  }

  // Test helper: Insert a user using sql
  insertUser(id: string, name: string, age: number) {
    this.svc.sql`
      INSERT INTO users (id, name, age)
      VALUES (${id}, ${name}, ${age})
    `;
  }

  // Test helper: Get user by ID using sql
  getUserById(id: string) {
    const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
    return rows[0];
  }

  // Test helper: Schedule an alarm using alarms
  async scheduleAlarm(when: Date | string | number, payload?: any) {
    return await this.svc.alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Test helper: Get a schedule by ID
  async getSchedule(id: string) {
    return await this.svc.alarms.getSchedule(id);
  }

  // Test helper: Cancel a schedule
  async cancelSchedule(id: string) {
    return await this.svc.alarms.cancelSchedule(id);
  }

  // Alarm callback - receives schedule as first parameter (injected by alarms)
  async handleAlarm(schedule: Schedule, payload: any) {
    this.executedAlarms.push({ payload, schedule });
  }

  // Test helper: Get executed alarms
  async getExecutedAlarms() {
    return this.executedAlarms;
  }

  // Test helper: Access non-existent service to trigger error
  async accessNonExistentService() {
    // @ts-expect-error - Intentionally accessing non-existent service
    return this.svc.nonExistent;
  }

  // Test helpers for this.lmz.init() - now obsolete, tests use this.lmz.init() directly

  async getStoredBindingName() {
    return this.ctx.storage.kv.get('__lmz_do_binding_name');
  }

  async getStoredInstanceName() {
    return this.ctx.storage.kv.get('__lmz_do_instance_name');
  }

  async clearStoredMetadata() {
    this.ctx.storage.kv.delete('__lmz_do_binding_name');
    this.ctx.storage.kv.delete('__lmz_do_instance_name');
  }

  // Test helper for fetch() with custom headers
  async testFetch(headers: Record<string, string> = {}) {
    const request = new Request('https://example.com', { headers });
    return await this.fetch(request);
  }

  // Test helpers for this.lmz.* API
  async testLmzType() {
    return this.lmz.type;
  }

  async testLmzGetBindingName() {
    return this.lmz.bindingName;
  }

  async testLmzSetBindingName(value: string) {
    this.lmz.bindingName = value;
  }

  async testLmzGetInstanceName() {
    return this.lmz.instanceName;
  }

  async testLmzSetInstanceName(value: string) {
    this.lmz.instanceName = value;
  }

  async testLmzGetId() {
    return this.lmz.id;
  }

  async testLmzSetId(value: string) {
    this.lmz.id = value;
  }

  async testLmzGetInstanceNameOrId() {
    return this.lmz.instanceNameOrId;
  }

  async testLmzSetInstanceNameOrId(value: string) {
    this.lmz.instanceNameOrId = value;
  }

  async testLmzApiInit(options?: { bindingName?: string; instanceNameOrId?: string }) {
    this.lmz.init(options);
  }

  // Test helpers for this.lmz.callRaw()
  async testCallRawWithContinuation(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    value: string
  ) {
    return await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceNameOrId,
      this.ctn<TestDO>().remoteEcho(value)
    );
  }

  async testCallRawWithOperationChain(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chain: any
  ) {
    return await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceNameOrId,
      chain
    );
  }

  // Remote method that can be called via RPC
  remoteEcho(value: string): string {
    return `echo: ${value}`;
  }

  // Remote method that returns caller identity
  getCallerIdentity(): { bindingName?: string; instanceNameOrId?: string; type: string } {
    return {
      bindingName: this.lmz.bindingName,
      instanceNameOrId: this.lmz.instanceNameOrId,
      type: this.lmz.type
    };
  }

  // Store last received envelope for inspection
  lastReceivedEnvelope: any = null;

  // Override __executeOperation to capture envelope
  async __executeOperation(envelope: any): Promise<any> {
    this.lastReceivedEnvelope = envelope;
    return await super.__executeOperation(envelope);
  }

  // Test helper to get last envelope
  async getLastEnvelope() {
    return this.lastReceivedEnvelope;
  }

  // Test helpers for this.lmz.call()
  testCallWithContinuations(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    value: string
  ): void {
    const remote = this.ctn<TestDO>().remoteEcho(value);
    this.lmz.call(
      calleeBindingName,
      calleeInstanceNameOrId,
      remote,
      this.ctn().handleCallResult(remote)
    );
  }

  testCallWithError(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined
  ): void {
    const remote = this.ctn<TestDO>().throwError();
    this.lmz.call(
      calleeBindingName,
      calleeInstanceNameOrId,
      remote,
      this.ctn().handleCallError(remote)
    );
  }

  // Handler for successful call results
  handleCallResult(result: any): void {
    this.ctx.storage.kv.put('last_call_result', result);
  }

  // Handler for call errors
  handleCallError(error: any): void {
    this.ctx.storage.kv.put('last_call_error', error instanceof Error ? error.message : String(error));
  }

  // Test helper to get last call result
  async getLastCallResult() {
    return this.ctx.storage.kv.get('last_call_result');
  }

  // Test helper to get last call error
  async getLastCallError() {
    return this.ctx.storage.kv.get('last_call_error');
  }

  // Remote method that throws an error
  throwError(): never {
    throw new Error('Remote error for testing');
  }

  // Validation test helpers (these throw synchronously, which we can test)
  async testLmzCallWithoutBinding(): Promise<void> {
    // This should throw because bindingName is not set
    const remote = this.ctn<TestDO>().remoteEcho('test');
    this.lmz.call('TEST_DO', 'callee', remote, this.ctn().handleCallResult(remote));
  }

  async testLmzCallWithInvalidRemote(): Promise<void> {
    // This should throw because remoteContinuation is invalid
    this.lmz.call(
      'TEST_DO',
      'callee',
      {} as any,
      this.ctn().handleCallResult({})
    );
  }

  async testLmzCallWithInvalidHandler(): Promise<void> {
    // This should throw because handlerContinuation is invalid
    const remote = this.ctn<TestDO>().remoteEcho('test');
    this.lmz.call(
      'TEST_DO',
      'callee',
      remote,
      {} as any
    );
  }
}

// Test DO that uses onStart() lifecycle hook
export class OnStartTestDO extends LumenizeDO<Env> {
  // Track whether onStart was called
  #onStartCalled = false;

  async onStart() {
    // Store a flag in storage to prove onStart ran
    this.ctx.storage.kv.put('__test_onstart_called', true);

    // Create a table (common use case for onStart)
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS onstart_test (
        id TEXT PRIMARY KEY,
        value TEXT
      )
    `;

    this.#onStartCalled = true;
  }

  // Test helper: Check if onStart was called
  wasOnStartCalled(): boolean {
    return this.#onStartCalled;
  }

  // Test helper: Check storage flag
  getOnStartFlag(): boolean | undefined {
    return this.ctx.storage.kv.get('__test_onstart_called') as boolean | undefined;
  }

  // Test helper: Insert into the table created by onStart
  insertValue(id: string, value: string): void {
    this.svc.sql`INSERT INTO onstart_test (id, value) VALUES (${id}, ${value})`;
  }

  // Test helper: Get value from the table
  getValue(id: string): { id: string; value: string } | undefined {
    const rows = this.svc.sql`SELECT * FROM onstart_test WHERE id = ${id}`;
    return rows[0] as { id: string; value: string } | undefined;
  }
}

// Test DO that throws in onStart()
export class OnStartErrorDO extends LumenizeDO<Env> {
  async onStart() {
    throw new Error('Intentional onStart error for testing');
  }

  // This should never be reachable if onStart fails
  getValue(): string {
    return 'should-not-reach';
  }
}

// Test Worker class for Worker-to-DO and Worker-to-Worker tests
export class TestWorker extends LumenizeWorker<Env> {
  // Store last received envelope for inspection
  lastReceivedEnvelope: any = null;

  // Override __executeOperation to capture envelope
  async __executeOperation(envelope: any): Promise<any> {
    this.lastReceivedEnvelope = envelope;
    return await super.__executeOperation(envelope);
  }

  // Test helper to get last envelope
  async getLastEnvelope() {
    return this.lastReceivedEnvelope;
  }

  // Identity getter methods for tests
  getType(): string {
    return this.lmz.type;
  }

  getBindingName(): string | undefined {
    return this.lmz.bindingName;
  }

  setBindingName(name: string | undefined): void {
    if (name === undefined) {
      // Reset by creating a new lmzApi (hack for tests)
      (this as any).lmzApi = null;
    } else {
      this.lmz.bindingName = name;
    }
  }

  initWithBindingName(name: string): void {
    this.lmz.init({ bindingName: name });
  }

  getInstanceName(): string | undefined {
    return this.lmz.instanceName;
  }

  getId(): string | undefined {
    return this.lmz.id;
  }

  getInstanceNameOrId(): string | undefined {
    return this.lmz.instanceNameOrId;
  }

  // Test setter/getter in same call (Workers are stateless between calls)
  testBindingNameSetterGetter(name: string): string {
    this.lmz.bindingName = name;
    return this.lmz.bindingName!;
  }

  testInitBindingName(name: string): string {
    this.lmz.init({ bindingName: name });
    return this.lmz.bindingName!;
  }

  // Continuation test methods
  testContinuationCreation(): string {
    const ctn = this.ctn<TestWorker>();
    // If we can create it without error, return success
    return 'continuation_works';
  }

  testContinuationToChain(): any {
    const ctn = this.ctn<TestWorker>().workerEcho('test');
    const chain = getOperationChain(ctn);
    return chain;
  }

  // Envelope test methods
  async testValidEnvelope(): Promise<string> {
    const chain = { 
      operations: [
        { type: 'call', property: 'workerEcho', args: ['envelope_test'] }
      ] 
    };
    const preprocessedChain = preprocess(chain);
    const envelope = {
      version: 1,
      chain: preprocessedChain,
      metadata: {}
    };
    
    await this.__executeOperation(envelope);
    return 'envelope_test_success';
  }

  async testAutoInitFromEnvelope(): Promise<string> {
    const chain = { 
      operations: [
        { type: 'call', property: 'getBindingName', args: [] }
      ] 
    };
    const preprocessedChain = preprocess(chain);
    const envelope = {
      version: 1,
      chain: preprocessedChain,
      metadata: {
        callee: {
          type: 'LumenizeWorker',
          bindingName: 'AUTO_INIT_WORKER',
          instanceNameOrId: undefined
        }
      }
    };
    
    return await this.__executeOperation(envelope);
  }

  // Identity test (must be in single call)
  testGetIdentityAfterInit(name: string): { type: string; bindingName: string } {
    this.lmz.init({ bindingName: name });
    return {
      type: this.lmz.type,
      bindingName: this.lmz.bindingName!
    };
  }

  // Test helpers for Worker RPC calls
  async testCallRawToDO(
    doBindingName: string,
    doInstanceNameOrId: string,
    value: string
  ): Promise<any> {
    return await this.lmz.callRaw(
      doBindingName,
      doInstanceNameOrId,
      this.ctn<TestDO>().remoteEcho(value)
    );
  }

  async testCallRawToWorker(
    workerBindingName: string,
    value: string
  ): Promise<any> {
    return await this.lmz.callRaw(
      workerBindingName,
      undefined,
      this.ctn<TestWorker>().workerEcho(value)
    );
  }

  // Remote methods that can be called via RPC
  workerEcho(value: string): string {
    return `worker-echo: ${value}`;
  }

  getWorkerIdentity(): { bindingName?: string; type: string } {
    return {
      bindingName: this.lmz.bindingName,
      type: this.lmz.type
    };
  }

  // Test that Workers silently ignore instance-related setters
  testInstanceSetters(): boolean {
    this.lmz.instanceName = 'should-be-ignored';
    this.lmz.id = 'should-be-ignored';
    this.lmz.instanceNameOrId = 'should-be-ignored';
    
    // All should remain undefined
    return (
      this.lmz.instanceName === undefined &&
      this.lmz.id === undefined &&
      this.lmz.instanceNameOrId === undefined
    );
  }
}

// Default export for worker
export default {
  async fetch(request: Request, env: Env) {
    return new Response('OK');
  },
};

